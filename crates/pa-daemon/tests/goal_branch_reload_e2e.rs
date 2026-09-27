//! End-to-end verifier for the goal state\'s branch reload (TS
//! `_reloadGoalStateFromBranch` at the `_navigateTree` tail, the #241
//! adjacent gap): a tree navigation rebuilds the session\'s context onto
//! the moved branch, and the goal state follows the cut — a branch that
//! predates the goal rows reloads the empty state, navigating back onto
//! the abandoned branch restores its own goal rows, and each reload\'s
//! change announces as a `goal_update` at the moment it happens.

#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const GOAL_STATE_CUSTOM_TYPE: &str = "thread_goal_state";
const OBJECTIVE: &str = "ship the goal-branch-reload port";

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
fn spawn_supervisor(socket: &Path, agent_dir: &Path) -> Supervisor {
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
        // A supervisor killed at teardown must not leak its session workers
        // into later test binaries.
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

/// One client connection: request/response plus every session event that
/// streamed while the response was outstanding.
struct Client {
    reader: BufReader<std::os::unix::net::UnixStream>,
    writer: std::os::unix::net::UnixStream,
    events: Vec<Value>,
}

impl Client {
    fn connect(socket: &Path) -> Client {
        let stream = std::os::unix::net::UnixStream::connect(socket).expect("connect");
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
        let deadline = Instant::now() + Duration::from_mins(5);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("timeout");
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

    /// The response for `id`, collecting every session event on the way.
    fn request(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_mins(5);
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

    /// Drain pending session events until the socket stays quiet.
    fn drain_events(&mut self, quiet_ms: Duration) {
        let deadline = Instant::now() + Duration::from_secs(30);
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
                    if last_line.elapsed() >= quiet_ms {
                        return;
                    }
                }
            }
        }
    }
}

/// The harness: a supervisor, a faux-scripted session over the real agent
/// engine, and an attached client (session events only reach attached
/// wire clients).
struct Harness {
    dir: tempfile::TempDir,
    _supervisor: Supervisor,
    client: Client,
    session_id: String,
}

fn setup(name: &str) -> Harness {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("sessions dir");
    let responses: Vec<Value> = (0..12)
        .map(|index| json!({ "text": format!("scripted reply {index}") }))
        .collect();
    let script = dir.path().join("faux.json");
    std::fs::write(
        &script,
        json!({ "engine": "faux", "responses": responses }).to_string(),
    )
    .expect("write faux script");
    let socket = dir.path().join(format!("{name}.sock"));
    let supervisor = spawn_supervisor(&socket, &agent_dir);
    let mut client = Client::connect(&socket);
    client.send_command(
        "c1",
        json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": session_dir.to_string_lossy(),
                "script": script.to_string_lossy(),
                "name": name,
            },
        }),
    );
    let created = client.request("c1");
    assert_eq!(created["success"], true, "create failed: {created:?}");
    let session_id = created["data"]["activeSessionId"]
        .as_str()
        .or_else(|| created["data"]["id"].as_str())
        .expect("active session id")
        .to_string();
    client.send_command(
        "a1",
        json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let attached = client.request("a1");
    assert_eq!(attached["success"], true, "attach failed: {attached:?}");
    Harness {
        dir,
        _supervisor: supervisor,
        client,
        session_id,
    }
}

impl Harness {
    fn session_file(&self) -> PathBuf {
        let session_dir = self.dir.path().join("agent").join("sessions");
        std::fs::read_dir(&session_dir)
            .expect("session dir readable")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| path.extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
            .expect("one session file")
    }

    fn prompt(&mut self, id: &str, message: &str) {
        self.client.send_command(
            id,
            json!({
                "type": "prompt_and_wait",
                "activeSessionId": self.session_id,
                "message": message,
            }),
        );
        let done = self.client.request(id);
        assert_eq!(done["success"], true, "prompt {id} failed: {done:?}");
        self.client.drain_events(Duration::from_secs(1));
    }

    /// The f18-battery prompt form: send and wait for the response without
    /// the quiet drain (the goal-continuation loop keeps the socket busy).
    fn prompt_racing_the_loop(&mut self, id: &str, message: &str) {
        self.client.send_command(
            id,
            json!({
                "type": "prompt_and_wait",
                "activeSessionId": self.session_id,
                "message": message,
            }),
        );
        let done = self.client.request(id);
        assert_eq!(done["success"], true, "prompt {id} failed: {done:?}");
    }

    /// The `/goal` status the session last answered (the driver\'s view —
    /// the durable `session_slash_command_result` rows the command wrote,
    /// latest first from the collected wire events, falling back to the
    /// session file for rows drained before collection).
    fn last_goal_status(&self) -> String {
        let wire = self
            .client
            .events
            .iter()
            .rev()
            .filter(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_end")
                    && event["message"]["customType"]
                        .as_str()
                        .is_some_and(|custom| custom.starts_with("session_slash_command"))
            })
            .filter_map(|event| event["message"]["content"].as_str().map(str::to_string))
            .find(|text| text.starts_with("Goal") || text.starts_with("No active goal"));
        if let Some(status) = wire {
            return status;
        }
        std::fs::read_to_string(self.session_file())
            .expect("session file readable")
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
            .filter(|entry| {
                entry.get("type").and_then(Value::as_str) == Some("custom_message")
                    && entry.get("customType").and_then(Value::as_str)
                        == Some("session_slash_command_result")
            })
            .filter_map(|entry| {
                entry
                    .get("content")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .next_back()
            .unwrap_or_default()
    }

    /// The `goal_update` announcements\' statuses, in wire order.
    fn announced_goal_statuses(&self) -> Vec<String> {
        self.client
            .events
            .iter()
            .filter(|event| event.get("type").and_then(Value::as_str) == Some("goal_update"))
            .filter_map(|event| event["goal"]["status"].as_str().map(str::to_string))
            .collect()
    }

    /// The flat tree\'s entry nodes (id + raw entry).
    fn flat_entries(&mut self, id: &str) -> Vec<Value> {
        self.client.send_command(
            id,
            json!({ "type": "get_session_tree", "activeSessionId": self.session_id }),
        );
        let tree = self.client.request(id);
        assert_eq!(tree["success"], true, "get_session_tree failed: {tree:?}");
        tree["data"]["flatNodes"]
            .as_array()
            .expect("flatNodes")
            .clone()
    }

    fn navigate(&mut self, id: &str, target_id: &str, summarize: bool) -> Value {
        self.client.send_command(
            id,
            json!({
                "type": "navigate_tree",
                "activeSessionId": self.session_id,
                "targetId": target_id,
                "summarize": summarize,
            }),
        );
        let response = self.client.request(id);
        assert_eq!(
            response["success"], true,
            "navigate_tree failed: {response:?}"
        );
        response
    }

    /// The id of the user message with exactly `text`.
    fn user_entry_id(nodes: &[Value], text: &str) -> String {
        nodes
            .iter()
            .find(|node| {
                node["entry"]["type"] == "message"
                    && node["entry"]["message"]["role"] == "user"
                    && message_text(&node["entry"]["message"]["content"]).as_deref() == Some(text)
            })
            .map_or_else(
                || panic!("the user message node: {nodes:?}"),
                |node| node["entry"]["id"].as_str().expect("entry id").to_string(),
            )
    }

    /// The tree\'s current leaf id.
    fn leaf_id(nodes: &[Value]) -> String {
        nodes
            .last()
            .map(|node| node["entry"]["id"].as_str().expect("entry id").to_string())
            .expect("at least one entry")
    }
}

/// The text of one user message row's content: the string form or the
/// concatenated text blocks.
fn message_text(content: &Value) -> Option<String> {
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(blocks) => Some(
            blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(""),
        ),
        _ => None,
    }
}

/// A tree navigation reloads the goal state from the moved branch (TS
/// `_reloadGoalStateFromBranch`): moving below every `thread_goal_state`
/// row leaves the driver on the branch\'s empty state (faithful time
/// travel), moving back onto the branch that owns the goal rows restores
/// them, and each reload announces its change as a `goal_update` the
/// navigation itself emits.
#[test]
fn navigate_tree_moves_follow_the_branchs_goal_state() {
    let mut harness = setup("goal-branch-reload");

    // A pre-goal seed turn: the branch below its user message predates
    // every goal row, so navigating there is the strongest faithful move.
    harness.prompt("s0", "seed turn before the goal");

    // Start a goal and pause it (the f18 battery pattern: the pause
    // withdraws the minted continuation and the loop goes quiet), so the
    // goal rows (active, then paused) sit on the branch after the seed.
    harness.prompt_racing_the_loop("g1", &format!("/goal {OBJECTIVE}"));
    harness.prompt_racing_the_loop("g2", "/goal pause");
    harness.client.drain_events(Duration::from_secs(1));

    // The driver is on the paused goal.
    harness.prompt("q1", "/goal");
    assert_eq!(
        harness.last_goal_status(),
        format!("Goal paused: {OBJECTIVE}")
    );

    // The tree: the seed user row is the pre-goal target; the current
    // leaf is the abandoned branch\'s tip to navigate back to.
    let nodes = harness.flat_entries("t1");
    let seed_user = Harness::user_entry_id(&nodes, "seed turn before the goal");
    let abandoned_leaf = Harness::leaf_id(&nodes);

    // Plain move below the goal rows: the moved branch carries no
    // `thread_goal_state` entry, so the driver reloads the branch\'s own
    // state — the empty state (TS faithful branch semantics), announced
    // as a `goal_update` by the navigation itself (TS `_emitGoalUpdate`).
    let statuses_before = harness.announced_goal_statuses();
    harness.navigate("n1", &seed_user, false);
    // The reload's empty-state `goal_update` is an async broadcast that
    // can trail the navigate response (TS `_emitGoalUpdate` fires after
    // the branch state loads); drain the wire before asserting on the
    // announced statuses, or the announcement may not be collected yet.
    harness.client.drain_events(Duration::from_millis(150));
    assert!(
        harness.announced_goal_statuses()[statuses_before.len()..]
            .iter()
            .any(|status| status == "idle"),
        "the pre-goal reload never announced the empty state: {:?}",
        harness.client.events
    );
    harness.prompt("q2", "/goal");
    assert_eq!(harness.last_goal_status(), "No active goal.");

    // Move back onto the abandoned branch: its own goal rows are the
    // branch\'s latest state again, and the paused goal restores with
    // them (the objective and id preserved, the durable counters).
    harness.navigate("n2", &abandoned_leaf, false);
    harness.prompt("q3", "/goal");
    assert_eq!(
        harness.last_goal_status(),
        format!("Goal paused: {OBJECTIVE}")
    );

    // The durable rows on the abandoned branch survived the round trip
    // untouched: the reload reads, it never rewrites.
    let rows = std::fs::read_to_string(harness.session_file())
        .expect("session file readable")
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .filter(|entry| {
            entry.get("type").and_then(Value::as_str) == Some("custom")
                && entry.get("customType").and_then(Value::as_str) == Some(GOAL_STATE_CUSTOM_TYPE)
        })
        .collect::<Vec<_>>();
    assert!(
        rows.iter().any(|row| row["data"]["status"] == "paused"
            && row["data"]["objective"].as_str() == Some(OBJECTIVE)),
        "the abandoned branch lost its goal rows: {rows:?}"
    );
}

/// The clear's reply reflects the action it took (the operator's
/// 2026-09-25 bug report): clearing a held goal record answers
/// "Goal cleared." — never the nothing-to-clear "No active goal." the TS
/// post-state read produces — announces the empty state, and clearing
/// again answers the plain status text.
#[test]
fn goal_clear_answers_the_action_it_took() {
    let mut harness = setup("goal-clear-reply");

    // The f18 battery pattern: seed a turn, start the goal, then pause it
    // so the minted continuation is withdrawn and the loop goes quiet
    // with the goal record (paused) held on the branch.
    harness.prompt("s0", "seed turn before the goal");
    harness.prompt_racing_the_loop("g1", &format!("/goal {OBJECTIVE}"));
    harness.prompt_racing_the_loop("g2", "/goal pause");
    harness.client.drain_events(Duration::from_secs(1));

    // Clearing the held record answers the action and announces the
    // empty state.
    let announced = harness.announced_goal_statuses().len();
    harness.prompt("q1", "/goal clear");
    assert_eq!(harness.last_goal_status(), "Goal cleared.");
    assert!(
        harness.announced_goal_statuses()[announced..]
            .iter()
            .any(|status| status == "idle"),
        "the clear never announced the empty state: {:?}",
        harness.client.events
    );

    // Clearing again (nothing to clear) and the plain status both answer
    // the unchanged status text.
    harness.prompt("q2", "/goal clear");
    assert_eq!(harness.last_goal_status(), "No active goal.");
    harness.prompt("q3", "/goal status");
    assert_eq!(harness.last_goal_status(), "No active goal.");
}
