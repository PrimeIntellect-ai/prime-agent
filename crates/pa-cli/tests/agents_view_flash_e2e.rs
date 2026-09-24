//! End-to-end verifier for the agents-view flash: a store seeded with
//! hundreds of dead subagent sessions under one parent whose worker
//! registers and then departs (the operator's fleet box: a departed
//! root's registration-seeded rows stayed in the roster forever, and the
//! agents view rendered them as top-level rows until the saved catalog
//! re-parented them minutes later). The stop must settle the unowned
//! rows out of the roster, so the first agents-view render is the live
//! roster alone — while the saved catalog keeps every dead row resumable
//! under the parent's collapsed tree.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use pa_daemon::rlm_ledger::{RlmSpawnInput, RlmSpawnLedger};
use pa_tui::agents_view::{AgentsHeadlessPlan, AgentsStep, AgentsViewOptions, AgentsViewUiMode};
use serde_json::{json, Value};

struct Supervisor {
    child: Child,
    socket: PathBuf,
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        graceful_shutdown(&self.socket);
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.socket);
    }
}

/// Stop the daemon on `socket` by protocol; kill the child when it fails.
fn graceful_shutdown(socket: &Path) {
    let Ok(stream) = UnixStream::connect(socket) else {
        return;
    };
    let Ok(write_half) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(stream);
    let mut writer = write_half;
    let mut hello = String::new();
    let _ = reader.read_line(&mut hello); // daemon_hello
    let command = serde_json::json!({
        "type": "command",
        "id": "test-shutdown",
        "protocol": { "name": "prime-agent.daemon", "version": 7 },
        "command": { "type": "shutdown" },
    });
    let Ok(mut line) = serde_json::to_string(&command) else {
        return;
    };
    line.push('\n');
    if writer.write_all(line.as_bytes()).is_err() {
        return;
    }
    let _ = writer.flush();
    let _ = reader
        .get_ref()
        .set_read_timeout(Some(Duration::from_secs(5)));
    let mut response = String::new();
    let _ = reader.read_line(&mut response);
}

#[allow(clippy::zombie_processes)]
fn spawn_supervisor(dir: &Path) -> Supervisor {
    let socket = dir.join("daemon.sock");
    let agent_dir = dir.join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let mut command = Command::new(env!("CARGO_BIN_EXE_prime-agent"));
    command
        .args(["--mode", "daemon", "--daemon-socket"])
        .arg(&socket)
        .env("PRIME_AGENT_CODING_AGENT_DIR", &agent_dir)
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
    command.env(
        pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
        "15000",
    );
    let child = command.spawn().expect("spawn prime-agent --mode daemon");
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if socket.exists() {
            return Supervisor { child, socket };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("supervisor socket never appeared");
}

/// One saved-session fixture: a version-3 session header (the parent
/// linkage for subagents), a display name, and a user/assistant exchange.
fn write_fixture(
    dir: &Path,
    id: &str,
    name: &str,
    parent: Option<&Path>,
    rlm_depth: u64,
    turns: &[(&str, &str)],
) -> PathBuf {
    let path = dir.join(format!("{id}.jsonl"));
    let mut content = format!(
        "{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"cwd\":\"/tmp\""
    );
    if let Some(parent) = parent {
        content.push_str(&format!(",\"parentSession\":\"{}\"", parent.display()));
    }
    content.push_str(&format!(",\"rlmDepth\":{rlm_depth}}}"));
    content.push('\n');
    content.push_str(&format!(
        "{{\"type\":\"session_info\",\"id\":\"{id}-info\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"name\":\"{name}\"}}\n"
    ));
    for (index, (user, assistant)) in turns.iter().enumerate() {
        content.push_str(&format!(
            "{{\"type\":\"message\",\"id\":\"{id}-m{index}u\",\"timestamp\":\"2024-01-01T00:00:0{index}.000Z\",\"message\":{{\"role\":\"user\",\"content\":\"{user}\",\"timestamp\":{}}}}}\n",
            index * 1000
        ));
        content.push_str(&format!(
            "{{\"type\":\"message\",\"id\":\"{id}-m{index}a\",\"timestamp\":\"2024-01-01T00:00:0{index}.000Z\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"{assistant}\"}}],\"timestamp\":{}}}}}\n",
            index * 1000 + 1
        ));
    }
    std::fs::write(&path, content).expect("write fixture");
    path
}

/// The client the agents view stands in for: a JSONL protocol client that
/// keeps every `roster_update` push it reads while awaiting a response.
struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
    roster_updates: Vec<Value>,
}

impl Client {
    fn connect(socket: &Path) -> Client {
        let stream = UnixStream::connect(socket).expect("connect");
        let writer = stream.try_clone().expect("clone");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer,
            roster_updates: Vec::new(),
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
            .expect("set timeout");
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => continue,
                Ok(_) => return serde_json::from_str(line.trim()).expect("parse line"),
                Err(error) => {
                    assert!(Instant::now() < deadline, "timed out reading: {error}");
                }
            }
        }
    }

    fn try_read_line(&mut self) -> Option<Value> {
        let mut line = String::new();
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => continue,
                Ok(_) => return serde_json::from_str(line.trim()).ok(),
                Err(_) => return None,
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

    /// The response for one command id; roster pushes read on the way are
    /// kept, and the stream frames of a saved-catalog scan are drained.
    fn request(&mut self, id: &str) -> Value {
        loop {
            let line = self.read_line();
            if line["type"] == "roster_update" {
                self.roster_updates.push(line);
                continue;
            }
            if line["type"] == "session_list_item" || line["type"] == "session_list_progress" {
                continue;
            }
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }

    /// Drain buffered and live `roster_update` pushes until the socket
    /// stays quiet for the window.
    fn drain_roster_pushes(&mut self, quiet: Duration) {
        self.roster_updates.clear();
        let mut last_line = Instant::now();
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            if self.try_read_line().is_some() {
                last_line = Instant::now();
            } else if Instant::now() - last_line >= quiet {
                return;
            }
        }
    }
}

/// The rows of one roster snapshot whose summary carries the dead
/// family's marker (a `rlmChildId` under the parent, or the parent's own
/// session file).
fn family_rows(roster: &[Value], parent_file: &Path, child_prefix: &str) -> usize {
    roster
        .iter()
        .filter(|entry| {
            let summary = &entry["summary"];
            summary["rlmChildId"]
                .as_str()
                .is_some_and(|id| id.starts_with(child_prefix))
                || summary["sessionFile"].as_str() == Some(&parent_file.to_string_lossy())
        })
        .count()
}

fn roster_of(response: &Value) -> Vec<Value> {
    response["data"]["roster"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

/// The first frame of one headless view run (the mount draw happens
/// before the saved-catalog fetch even spawns, so this is the frame the
/// live roster alone produced).
fn first_frame(frames: &[String]) -> String {
    frames
        .first()
        .cloned()
        .unwrap_or_else(|| panic!("no frame rendered"))
}

/// The last frame containing `marker`.
fn frame_of(frames: &[String], marker: &str) -> String {
    frames
        .iter()
        .rev()
        .find(|frame| frame.contains(marker))
        .unwrap_or_else(|| {
            panic!(
                "no frame shows {marker:?}; frames:\n{}",
                frames.join("\n---frame---\n")
            )
        })
        .clone()
}

fn view_options(socket: &Path, session_dir: &Path) -> AgentsViewOptions {
    AgentsViewOptions {
        socket_path: socket.to_path_buf(),
        cwd: PathBuf::from("/tmp"),
        session_dir: Some(session_dir.to_path_buf()),
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: None,
        scope: None,
        query: None,
        expanded_ancestors: Vec::new(),
        selected_row_identity: None,
        selected_key: None,
        status_message: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
    }
}

/// The dead family's children count: hundreds, like the operator's box.
const DEAD_CHILDREN: usize = 300;

#[tokio::test]
async fn the_first_agents_view_render_is_clean_behind_hundreds_of_dead_subagents() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("session dir");

    // The mock provider registers without any prompt ever running (the
    // create and the stop are turn-free paths).
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "battery": {
                    "api": "openai-completions",
                    "baseUrl": "http://127.0.0.1:9/v1",
                    "apiKey": "sk-battery",
                    "models": [
                        {
                            "id": "mock-1",
                            "name": "Mock 1",
                            "api": "openai-completions",
                            "reasoning": true,
                            "contextWindow": 128000,
                            "maxTokens": 4096
                        }
                    ]
                }
            }
        })
        .to_string(),
    )
    .expect("write models.json");

    // The dead family: one parent in the sessions dir and hundreds of
    // subagent transcripts under session-artifacts (the RLM layout the
    // scan never visits; the ledger walk carries them), with the spawn
    // edges written before the parent ever registers.
    let parent_file = write_fixture(
        &sessions_dir,
        "flash-parent",
        "flash parent",
        None,
        0,
        &[("run the fleet drill", "the drill ran")],
    );
    let artifacts_dir = agent_dir.join("session-artifacts").join("flash-parent");
    let ledger = RlmSpawnLedger::new(&agent_dir, &sessions_dir, |_| {});
    for index in 0..DEAD_CHILDREN {
        let child_dir = artifacts_dir.join(format!("sub-{index}"));
        std::fs::create_dir_all(&child_dir).expect("child dir");
        let child_file = write_fixture(
            &child_dir,
            &format!("flash-child-{index:03}"),
            &format!("flash worker {index:03}"),
            Some(&parent_file),
            1,
            &[("do the work", "work complete")],
        );
        ledger
            .append_spawn(RlmSpawnInput {
                child_id: format!("sub-{index}"),
                parent: parent_file.to_string_lossy().to_string(),
                child: child_file.to_string_lossy().to_string(),
                depth: 1,
                name: format!("flash worker {index:03}"),
            })
            .expect("append spawn edge");
    }

    let supervisor = spawn_supervisor(dir.path());
    let mut client = Client::connect(&supervisor.socket);

    // Before the family's worker ever registers, the roster snapshot is
    // clean of the dead family (nothing anchors it).
    client.send_command("r0", json!({ "type": "roster_subscribe" }));
    let before = client.request("r0");
    assert_eq!(before["success"], true, "roster_subscribe: {before}");
    assert_eq!(
        family_rows(&roster_of(&before), &parent_file, "sub-"),
        0,
        "an unregistered family never reaches the roster: {before}"
    );

    // The parent's worker registers (the create resumes the fixture
    // file): the registration seed walks the live ledger family and the
    // roster serves the hundreds of seeded rows - TS parity while the
    // root is resident.
    client.send_command(
        "c1",
        json!({
            "type": "create",
            "sessionPath": parent_file.to_string_lossy(),
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
                "provider": "battery",
                "model": "mock-1",
                "thinking": "low",
            },
        }),
    );
    let created = client.request("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let active_id = created["data"]["activeSessionId"]
        .as_str()
        .or_else(|| created["data"]["id"].as_str())
        .expect("the active session id")
        .to_string();
    client.drain_roster_pushes(Duration::from_millis(500));
    client.send_command("r1", json!({ "type": "roster_subscribe" }));
    let resident = client.request("r1");
    assert_eq!(
        family_rows(&roster_of(&resident), &parent_file, "sub-"),
        DEAD_CHILDREN + 1,
        "a resident root's own row plus its seeded family serves to subscribers: {resident}"
    );

    // The worker departs (the operator's stale-worker stop): the family
    // loses its only resident root, so its rows settle out of the roster
    // with the stop.
    client.send_command(
        "k1",
        json!({ "type": "kill", "activeSessionId": active_id }),
    );
    let killed = client.request("k1");
    assert_eq!(killed["success"], true, "kill failed: {killed}");
    client.drain_roster_pushes(Duration::from_millis(500));
    client.send_command("r2", json!({ "type": "roster_subscribe" }));
    let departed = client.request("r2");
    assert_eq!(
        family_rows(&roster_of(&departed), &parent_file, "sub-"),
        0,
        "the departed family's rows left the roster: {departed}"
    );

    // The saved catalog keeps every dead row resumable (the passive
    // ledger walk): the parent plus its hundreds of children.
    client.send_command(
        "s1",
        json!({ "type": "list_saved_sessions", "cwd": dir.path().to_string_lossy() }),
    );
    let saved = client.request("s1");
    assert_eq!(saved["success"], true, "list_saved_sessions: {saved}");
    let parent_path = parent_file.to_string_lossy().to_string();
    let children = saved["data"]["sessions"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter(|row| row["parentSessionPath"].as_str() == Some(parent_path.as_str()))
                .count()
        })
        .unwrap_or_default();
    assert_eq!(children, DEAD_CHILDREN, "the dead rows stay resumable");

    // The agents view: the first frame renders the live roster the
    // moment the surface mounts (the saved-catalog fetch has not even
    // spawned yet), so it never dumps the dead family's rows as
    // top-level entries - the flash the operator saw. The settled frame
    // carries the dead family through the parent's collapsed tree, and
    // the drill-in reaches the dead children.
    let plan = AgentsHeadlessPlan {
        steps: vec![
            AgentsStep::WaitSettle { timeout_ms: 2_000 },
            AgentsStep::Key("alt+right".to_string()),
            AgentsStep::WaitSettle { timeout_ms: 500 },
        ],
        width: 120,
        height: 36,
    };
    let view = pa_tui::agents_view::run_agents_view(
        view_options(&supervisor.socket, &sessions_dir),
        AgentsViewUiMode::Headless(plan),
        None,
    )
    .await
    .expect("agents view run")
    .outcome;

    let first = first_frame(&view.frames);
    assert!(
        !first.contains("flash worker"),
        "the first render shows no dead family rows:\n{first}"
    );
    let settled = frame_of(&view.frames, "flash parent");
    assert!(
        settled.contains("300 subagents"),
        "the settled frame carries the dead family behind the parent's collapsed tree:\n{settled}"
    );
    let expanded = frame_of(&view.frames, "flash worker 007");
    assert!(
        !expanded.contains("▸ 300 subagents"),
        "the expansion opens the parent's list:\n{expanded}"
    );
}
