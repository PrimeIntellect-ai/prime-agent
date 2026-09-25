//! End-to-end verifier for the interrupt on a running kernel cell (the
//! dogfood P0 wedge): a daemon worker session whose turn executes a long
//! kernel cell must abort at once - `abort` cancels the in-flight tool
//! execution (kernel interrupt + force-abort), the turn unwinds, and the
//! session returns to ready - instead of running the cell out or wedging
//! with the loader spinning. Drives the exact worker stack (real kernel,
//! real turn runner) over the daemon wire.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// The kernel Python with prime-agent-runtime installed; the release dir
/// ships the runtime sidecar. Skipped (with a note) on machines without a
/// live install.
fn kernel_python() -> Option<PathBuf> {
    let candidate = PathBuf::from(std::env::var("HOME").map_or_else(
        |_| "/home/ubuntu/.prime/agent/kernel-venv/bin/python".to_string(),
        |home| format!("{home}/.prime/agent/kernel-venv/bin/python"),
    ));
    if candidate.exists() {
        return Some(candidate);
    }
    eprintln!("kernel python {candidate:?} not found; skipping live kernel test");
    None
}

fn release_dir() -> Option<PathBuf> {
    let releases = PathBuf::from(std::env::var("HOME").map_or_else(
        |_| "/home/ubuntu/.local/share/prime-agent/releases".to_string(),
        |home| format!("{home}/.local/share/prime-agent/releases"),
    ));
    let Ok(entries) = std::fs::read_dir(&releases) else {
        eprintln!("no releases dir at {releases:?}; skipping live kernel test");
        return None;
    };
    let mut candidates: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.join("prime-agent-runtime").is_dir())
        .collect();
    candidates.sort();
    candidates.pop()
}

/// The faux provider script: turn one calls the kernel with a cell that
/// writes its start marker, sleeps far past the abort budget, and would
/// write its finish marker afterwards. Turn two answers the (never
/// reached) continuation.
fn faux_script(dir: &Path) -> PathBuf {
    let path = dir.join("faux-script.json");
    std::fs::write(
        &path,
        json!({
            "engine": "faux",
            "modelId": "faux-1",
            "modelName": "Faux Model",
            "reasoning": false,
            "contextWindow": 128_000,
            "tokensPerSecond": 30,
            "responses": [
                {"content": [
                    {"type": "text", "text": "Running the wedge cell."},
                    {"type": "toolCall", "name": "ipython", "id": "toolu_wedge01",
                     "arguments": {"code":
                        "import time\nopen('wedge-started', 'w').write('1')\ntime.sleep(300)\nopen('wedge-finished', 'w').write('1')\nprint('cell completed')"}}
                ]},
                {"content": [{"type": "text", "text": "The cell completed."}]}
            ]
        })
        .to_string(),
    )
    .expect("write faux script");
    path
}

struct Supervisor {
    child: Child,
    #[allow(dead_code)]
    socket: PathBuf,
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[allow(clippy::zombie_processes)]
fn spawn_supervisor(socket: &Path, agent_dir: &Path, script: &Path) -> Supervisor {
    std::fs::create_dir_all(agent_dir).expect("agent dir");
    let child = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env_remove("PRIME_API_KEY")
        .env_remove("PRIME_AGENT_CODING_AGENT_DIR")
        .env(pa_daemon::worker::WORKER_SCRIPT_ENV, script)
        .env(
            "PRIME_AGENT_KERNEL_PYTHON",
            kernel_python().expect("kernel python"),
        )
        .env("PI_PACKAGE_DIR", release_dir().expect("release dir"))
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
        .spawn()
        .expect("spawn pa-daemon supervisor");
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if socket.exists() {
            return Supervisor {
                child,
                socket: socket.to_path_buf(),
            };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("supervisor socket never appeared");
}

struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
    events: Vec<Value>,
}

impl Client {
    fn connect(socket: &Path) -> Client {
        let stream = UnixStream::connect(socket).expect("connect");
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
        let deadline = Instant::now() + Duration::from_mins(1);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("timeout");
        loop {
            let mut line = String::new();
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

    fn send_command(&mut self, id: &str, command: Value) {
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
        let deadline = Instant::now() + Duration::from_mins(2);
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

    fn send(&mut self, id: &str, command: Value) -> Value {
        self.send_command(id, command);
        self.request(id)
    }

    /// Drain until the socket stays quiet for `quiet_ms`.
    fn drain_events(&mut self, quiet_ms: Duration) {
        let deadline = Instant::now() + Duration::from_mins(1);
        let mut last_line = Instant::now();
        loop {
            assert!(Instant::now() < deadline, "event drain timed out");
            let mut line = String::new();
            self.reader
                .get_mut()
                .set_read_timeout(Some(Duration::from_millis(100)))
                .expect("timeout");
            match self.reader.read_line(&mut line) {
                Ok(0) => return,
                Ok(_) => {
                    let value: Value = serde_json::from_str(line.trim()).expect("parse line");
                    self.collect_event(&value);
                    last_line = Instant::now();
                }
                Err(_) => {
                    if Instant::now() - last_line >= quiet_ms {
                        return;
                    }
                }
            }
        }
    }
}

/// An abort on a running kernel cell settles the worker's turn at once:
/// the turn unwinds (`turn_end` + `agent_end` reach attached clients within
/// the budget) and the cell dies (its finish marker never appears). A
/// wedge keeps the loader spinning while the cell runs out.
#[test]
fn abort_during_a_kernel_cell_settles_the_daemon_turn_immediately() {
    let Some(_) = kernel_python() else {
        return;
    };
    let Some(_) = release_dir() else {
        return;
    };
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    let cwd = dir.path().join("project");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    std::fs::create_dir_all(&cwd).expect("project dir");
    let script = faux_script(dir.path());
    let socket = dir.path().join("abort-kernel.sock");
    let supervisor = spawn_supervisor(&socket, &agent_dir, &script);
    let mut client = Client::connect(&socket);
    let created = client.send(
        "c1",
        json!({
            "type": "create",
            "config": {
                "cwd": cwd.to_string_lossy(),
                "sessionDir": session_dir.to_string_lossy(),
                "model": "faux-1",
            },
        }),
    );
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();
    let attached = client.send(
        "a1",
        json!({ "type": "attach", "activeSessionId": session_id }),
    );
    assert_eq!(attached["success"], true, "attach failed: {attached}");

    // The turn starts; the cell's start marker lands once the kernel boots.
    let started = client.send(
        "p1",
        json!({ "type": "prompt", "activeSessionId": session_id, "message": "run the wedge cell" }),
    );
    assert_eq!(started["success"], true, "prompt failed: {started}");
    let marker = cwd.join("wedge-started");
    let deadline = Instant::now() + Duration::from_mins(3);
    while Instant::now() < deadline {
        if marker.exists() {
            break;
        }
        client.drain_events(Duration::from_millis(300));
    }
    assert!(
        marker.exists(),
        "the wedge cell never started; events: {:#?}",
        client.events
    );

    // Abort strictly mid-cell.
    let aborted = client.send(
        "x1",
        json!({ "type": "abort", "activeSessionId": session_id }),
    );
    assert_eq!(aborted["success"], true, "abort failed: {aborted}");

    // The turn unwinds at once: a wedge leaves the events quiet while the
    // cell runs the sleep out.
    let settle = Instant::now() + Duration::from_secs(20);
    loop {
        client.drain_events(Duration::from_millis(400));
        let types = event_types(&client.events);
        if types.iter().any(|t| t == "agent_end") {
            break;
        }
        assert!(
            Instant::now() < settle,
            "the aborted turn never settled; events: {types:?}"
        );
    }

    // The cell died: the finish marker never appears, even past the settle.
    std::thread::sleep(Duration::from_secs(3));
    assert!(
        !cwd.join("wedge-finished").exists(),
        "the interrupted cell must not run to completion"
    );
    drop(supervisor);
}

fn event_types(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| event.get("type").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}
