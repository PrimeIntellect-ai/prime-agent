//! End-to-end verifier for the interrupt on a running kernel cell (the dogfood
//! P0 wedge): a worker session whose turn executes a long kernel cell must abort
//! at once — the turn unwinds, the session returns to ready — instead of running
//! the cell out or wedging with the loader spinning.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// The kernel Python with prime-agent-runtime installed. Skipped (with a
/// note) on machines without a live install.
fn kernel_python() -> Option<PathBuf> {
    let candidate = PathBuf::from(std::env::var("HOME").map_or_else(
        |_| "/home/ubuntu/.prime/agent/kernel-venv/bin/python".to_string(),
        |home| format!("{home}/.prime/agent/kernel-venv/bin/python"),
    ));
    if candidate.exists() {
        return Some(candidate);
    }
    eprintln!(
        "kernel python {} not found; skipping live kernel test",
        candidate.display()
    );
    None
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
                    {"type": "toolCall", "name": "python_repl", "id": "toolu_wedge01",
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
        let mut line = String::new();
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

    fn send(&mut self, id: &str, command: &Value) -> Value {
        self.send_command(id, command);
        self.request(id)
    }

    /// Drain until the socket stays quiet for `quiet_ms`.
    fn drain_events(&mut self, quiet_ms: Duration) {
        let deadline = Instant::now() + Duration::from_mins(1);
        let mut last_line = Instant::now();
        let mut line = String::new();
        loop {
            assert!(Instant::now() < deadline, "event drain timed out");
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
                    line.clear();
                }
                Err(_) => {
                    if last_line.elapsed() >= quiet_ms {
                        return;
                    }
                }
            }
        }
    }
}

/// The turn unwinds within the budget and the cell dies (its finish marker never appears).
#[test]
fn abort_during_a_kernel_cell_settles_the_daemon_turn_immediately() {
    let Some(_) = kernel_python() else {
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
        &json!({
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
        &json!({ "type": "attach", "activeSessionId": session_id }),
    );
    assert_eq!(attached["success"], true, "attach failed: {attached}");

    // The turn starts; the cell's start marker lands once the kernel boots.
    let started = client.send(
        "p1",
        &json!({ "type": "prompt", "activeSessionId": session_id, "message": "run the wedge cell" }),
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
        &json!({ "type": "abort", "activeSessionId": session_id }),
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

fn event_rows(events: &[Value]) -> Vec<(String, String)> {
    events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("message_end"))
        .filter_map(|event| {
            let message = event.get("message")?;
            let role = message.get("role").and_then(Value::as_str)?;
            let text = match message.get("content") {
                Some(Value::String(text)) => text.clone(),
                Some(Value::Array(blocks)) => blocks
                    .iter()
                    .filter_map(|block| block.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join(""),
                _ => String::new(),
            };
            Some((role.to_string(), text))
        })
        .collect()
}

fn event_types(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| event.get("type").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

/// The faux script for the idle-cancel round: turn one calls a kernel cell
/// that outlives its 2s wait budget (it auto-backgrounds), catches the
/// interrupt, and keeps running; turn two runs a fresh cell on the revived
/// kernel.
fn faux_idle_cancel_script(dir: &Path) -> PathBuf {
    let path = dir.join("faux-idle-cancel.json");
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
                    {"type": "text", "text": "Running the background cell."},
                    {"type": "toolCall", "name": "python_repl", "id": "toolu_bg01",
                     "arguments": {"code":
                        "import time\nopen('bg-started', 'w').write('1')\ntry:\n    time.sleep(120)\nexcept KeyboardInterrupt:\n    open('bg-caught', 'w').write('1')\n    while True:\n        time.sleep(0.05)\nprint('cell completed')",
                        "timeout": 2}}
                ]},
                {"content": [{"type": "text", "text": "The cell backgrounds; ending the turn."}]},
                {"content": [
                    {"type": "text", "text": "Running the fresh cell."},
                    {"type": "toolCall", "name": "python_repl", "id": "toolu_fresh01",
                     "arguments": {"code": "print('fresh cell ok')"}}
                ]},
                {"content": [{"type": "text", "text": "The fresh cell completed."}]}
            ]
        })
        .to_string(),
    )
    .expect("write faux script");
    path
}

/// The idle cancel reaches a parked backgrounded cell (the runaway-cell
/// round): after the turn ends, the scoped `abort` interrupts the detached
/// cell; a cell that catches the interrupt and keeps running has its kernel
/// retired at the grace, its terminal notice lands, and a fresh cell runs on
/// the revived kernel — no later call fails busy forever, and no cell is
/// unstoppable.
#[test]
#[allow(clippy::too_many_lines)]
fn an_idle_scoped_abort_stops_a_parked_backgrounded_cell() {
    let Some(_) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    let cwd = dir.path().join("project");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    std::fs::create_dir_all(&cwd).expect("project dir");
    let script = faux_idle_cancel_script(dir.path());
    let socket = dir.path().join("idle-cancel.sock");
    let supervisor = spawn_supervisor(&socket, &agent_dir, &script);
    let mut client = Client::connect(&socket);
    let created = client.send(
        "c1",
        &json!({
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
        &json!({ "type": "attach", "activeSessionId": session_id }),
    );
    assert_eq!(attached["success"], true, "attach failed: {attached}");

    // Turn one: the cell starts, outlives its 2s wait budget, and the
    // tool result returns early with the auto-background note.
    let started = client.send(
        "p1",
        &json!({ "type": "prompt", "activeSessionId": session_id, "message": "run the background cell" }),
    );
    assert_eq!(started["success"], true, "prompt failed: {started}");
    let marker = cwd.join("bg-started");
    let deadline = Instant::now() + Duration::from_mins(3);
    while Instant::now() < deadline {
        if marker.exists() {
            break;
        }
        client.drain_events(Duration::from_millis(300));
    }
    assert!(
        marker.exists(),
        "the background cell never started; events: {:#?}",
        client.events
    );

    // The turn settles while the cell keeps running detached.
    let settle = Instant::now() + Duration::from_secs(30);
    loop {
        client.drain_events(Duration::from_millis(400));
        let rows = event_rows(&client.events);
        let backgrounded = rows
            .iter()
            .any(|(role, text)| role == "toolResult" && text.contains("auto-backgrounded"));
        let turn_done = event_types(&client.events).iter().any(|t| t == "agent_end");
        if backgrounded && turn_done {
            break;
        }
        assert!(
            Instant::now() < settle,
            "the backgrounding turn never settled; rows: {rows:?}; events: {:?}",
            event_types(&client.events)
        );
    }

    // The scoped abort while idle: it must reach ONLY the parked cell and
    // leave the session otherwise untouched.
    let aborted = client.send(
        "x1",
        &json!({
            "type": "abort",
            "activeSessionId": session_id,
            "scope": "background_cell"
        }),
    );
    assert_eq!(aborted["success"], true, "scoped abort failed: {aborted}");

    // The interrupt reached the detached cell: it caught the
    // KeyboardInterrupt and kept running.
    let caught = cwd.join("bg-caught");
    let caught_by = Instant::now() + Duration::from_secs(15);
    while Instant::now() < caught_by {
        if caught.exists() {
            break;
        }
        client.drain_events(Duration::from_millis(200));
    }
    assert!(
        caught.exists(),
        "the idle cancel never reached the parked backgrounded cell"
    );

    // The ignored interrupt retired the kernel, and the forced-stop
    // completion published as the cell's terminal notice (the inbox
    // arrival row; the status rides the inbox message the notice points
    // at).
    let noticed = Instant::now() + Duration::from_secs(20);
    loop {
        client.drain_events(Duration::from_millis(400));
        let rows = event_rows(&client.events);
        if rows
            .iter()
            .any(|(_, text)| text.contains("new message (cell-done)"))
        {
            break;
        }
        assert!(
            Instant::now() < noticed,
            "the retired cell's terminal notice never landed; rows: {rows:?}"
        );
    }

    // A fresh cell runs on the revived kernel: the retired manager never
    // fails later calls busy.
    let second = client.send(
        "p2",
        &json!({ "type": "prompt", "activeSessionId": session_id, "message": "run the fresh cell" }),
    );
    assert_eq!(second["success"], true, "second prompt failed: {second}");
    let fresh = Instant::now() + Duration::from_mins(2);
    loop {
        client.drain_events(Duration::from_millis(400));
        let rows = event_rows(&client.events);
        if rows
            .iter()
            .any(|(role, text)| role == "toolResult" && text.contains("fresh cell ok"))
        {
            break;
        }
        assert!(
            Instant::now() < fresh,
            "the fresh cell never ran on the revived kernel; rows: {rows:?}"
        );
    }
    drop(supervisor);
}

/// The UNSCOPED abort (the full funnel) also reaches a parked backgrounded
/// cell through the session abort path's kernel arm: an idle session with no
/// run left still stops the detached cell (the run signal alone cannot). The
/// full funnel parks the queue until a resume site, by design — the retired
/// cell's terminal notice rides the parked queue like every notice row, and
/// the resume delivers it; the notice turn's fresh cell proves the retired
/// kernel revived.
#[test]
#[allow(clippy::too_many_lines)]
fn a_late_unscoped_abort_stops_a_parked_backgrounded_cell() {
    let Some(_) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    let cwd = dir.path().join("project");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    std::fs::create_dir_all(&cwd).expect("project dir");
    let script = faux_idle_cancel_script(dir.path());
    let socket = dir.path().join("late-abort.sock");
    let supervisor = spawn_supervisor(&socket, &agent_dir, &script);
    let mut client = Client::connect(&socket);
    let created = client.send(
        "c1",
        &json!({
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
        &json!({ "type": "attach", "activeSessionId": session_id }),
    );
    assert_eq!(attached["success"], true, "attach failed: {attached}");

    // Turn one: the cell detaches at its 2s wait budget and the turn ends.
    let started = client.send(
        "p1",
        &json!({ "type": "prompt", "activeSessionId": session_id, "message": "run the background cell" }),
    );
    assert_eq!(started["success"], true, "prompt failed: {started}");
    let marker = cwd.join("bg-started");
    let deadline = Instant::now() + Duration::from_mins(3);
    while Instant::now() < deadline {
        if marker.exists() {
            break;
        }
        client.drain_events(Duration::from_millis(300));
    }
    assert!(marker.exists(), "the background cell never started");
    let settle = Instant::now() + Duration::from_secs(30);
    loop {
        client.drain_events(Duration::from_millis(400));
        let rows = event_rows(&client.events);
        let backgrounded = rows
            .iter()
            .any(|(role, text)| role == "toolResult" && text.contains("auto-backgrounded"));
        let turn_done = event_types(&client.events).iter().any(|t| t == "agent_end");
        if backgrounded && turn_done {
            break;
        }
        assert!(
            Instant::now() < settle,
            "the backgrounding turn never settled"
        );
    }

    // The UNSCOPED abort while idle: the session abort path's kernel arm
    // must reach the detached cell (no run is left to cancel).
    let aborted = client.send(
        "x1",
        &json!({ "type": "abort", "activeSessionId": session_id }),
    );
    assert_eq!(aborted["success"], true, "abort failed: {aborted}");

    // The interrupt reached the detached cell: it caught the
    // KeyboardInterrupt and kept running.
    let caught = cwd.join("bg-caught");
    let caught_by = Instant::now() + Duration::from_secs(15);
    while Instant::now() < caught_by {
        if caught.exists() {
            break;
        }
        client.drain_events(Duration::from_millis(200));
    }
    assert!(
        caught.exists(),
        "the idle unscoped abort never reached the parked backgrounded cell"
    );

    // The ignored interrupt retired the kernel: the forced-stop completion
    // parks as the terminal notice (the full funnel suspends the queue, and
    // the row exists only after the kill — it is also the retirement proof).
    let parked = Instant::now() + Duration::from_secs(20);
    loop {
        client.drain_events(Duration::from_millis(200));
        let queue = client.send(
            "q1",
            &json!({ "type": "get_queue", "activeSessionId": session_id }),
        );
        let parked_notice = queue["data"]["steering"].as_array().is_some_and(|rows| {
            rows.iter()
                .any(|row| row.as_str().is_some_and(|text| text.contains("cell-done")))
        });
        if parked_notice {
            break;
        }
        assert!(
            Instant::now() < parked,
            "the retired cell's terminal notice never parked: {queue:#?}"
        );
    }
    // The resume site delivers the parked notice as its own turn, and that
    // turn's fresh cell runs on the revived kernel — the retired manager
    // never fails later calls busy forever.
    let resumed = client.send(
        "r1",
        &json!({ "type": "resume_queue", "activeSessionId": session_id }),
    );
    assert_eq!(
        resumed["success"], true,
        "the queue resume failed: {resumed}"
    );
    let settled = Instant::now() + Duration::from_mins(3);
    loop {
        client.drain_events(Duration::from_millis(400));
        let rows = event_rows(&client.events);
        let noticed = rows
            .iter()
            .any(|(_, text)| text.contains("new message (cell-done)"));
        let fresh = rows
            .iter()
            .any(|(role, text)| role == "toolResult" && text.contains("fresh cell ok"));
        if noticed && fresh {
            break;
        }
        assert!(
            Instant::now() < settled,
            "the parked notice or the revived fresh cell never landed: {rows:?}"
        );
    }
    drop(supervisor);
}
