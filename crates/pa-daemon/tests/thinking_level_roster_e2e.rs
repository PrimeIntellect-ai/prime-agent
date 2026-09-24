//! End-to-end verifier for the agents-view thinking-level roster push: a
//! `thinking_level_change` (the `set_thinking_level` command) must reach the
//! roster surfaces immediately, in the same turn-free window the TS worker
//! covers (`ROSTER_SESSION_EVENT_TRIGGERS` includes `thinking_level_changed`,
//! and the `set_model`/`cycle_model` handlers flush explicitly) — a raise
//! the roster never carries leaves the agents view rendering the stale
//! `model:low` until the next turn's busy flip.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

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
        // into later test binaries: the worker's supervisor-lost exit (TS
        // `exitIfSupervisorOrphanedForTooLong`) runs on this short window
        // instead of the 5-minute default.
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

/// The client the agents view stands in for: a roster subscriber that keeps
/// every `roster_update` push (a push read while awaiting a command
/// response must not be dropped — the push and the response race, and
/// either order is valid).
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

    /// One buffered line, if one arrived inside the short window (None on
    /// the read timeout): the quiet-window assertions poll with it.
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

    /// The response for one command id; `roster_update` pushes read on the
    /// way are parked in the buffer instead of dropped.
    fn request(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line["type"] == "roster_update" {
                self.roster_updates.push(line);
                continue;
            }
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }

    /// The first `roster_update` push whose changed entries satisfy
    /// `accept` — buffered or live (the frame the subscribed agents view
    /// renders).
    fn next_roster_update<F>(&mut self, accept: F) -> Value
    where
        F: Fn(&Value) -> bool,
    {
        if let Some(index) = self.roster_updates.iter().position(&accept) {
            return self.roster_updates.remove(index);
        }
        // Poll (not block in read_line): the deadline assertion is the
        // repro's failure message, so it must fire inside this loop.
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(
                Instant::now() < deadline,
                "no matching roster_update arrived (the roster push never carried the change)"
            );
            if let Some(line) = self.try_read_line() {
                if line["type"] == "roster_update" {
                    if accept(&line) {
                        return line;
                    }
                    self.roster_updates.push(line);
                }
            }
        }
    }

    /// Drain buffered and live `roster_update` pushes until the socket
    /// stays quiet for the window: the create's `SessionCreated`
    /// re-registration refreshes the roster row with the persisted session
    /// id (a benign idempotent push that can land any time after the
    /// create), so a quiet-window measurement drains it first.
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

    /// The `roster_update` pushes that arrive inside the window (any
    /// buffered push counts as an in-window arrival too).
    fn roster_pushes_within(&mut self, window: Duration) -> Vec<Value> {
        let mut seen = Vec::new();
        seen.append(&mut self.roster_updates);
        let deadline = Instant::now() + window;
        while Instant::now() < deadline {
            if let Some(line) = self.try_read_line() {
                if line["type"] == "roster_update" {
                    seen.push(line);
                }
            }
        }
        seen
    }
}

struct Harness {
    #[allow(dead_code)]
    dir: tempfile::TempDir,
    agent_dir: PathBuf,
    session_dir: PathBuf,
    #[allow(dead_code)]
    supervisor: Supervisor,
    client: Client,
    session_id: String,
    persisted_id: String,
}

#[allow(clippy::zombie_processes)]
fn setup(name: &str) -> Harness {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    // `mock-1` reasons without a thinkingLevelMap (off..high); `mock-2`
    // does not reason at all, so a switch to it clamps the level to `off`.
    // No prompt ever runs: the thinking switches and the roster pushes they
    // trigger are turn-free paths, so the mock provider is just the
    // registry entry the engine resolves from disk.
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
                        },
                        {
                            "id": "mock-2",
                            "name": "Mock 2",
                            "api": "openai-completions",
                            "reasoning": false,
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
                "provider": "battery",
                "model": "mock-1",
                "thinking": "low",
            },
        }),
    );
    let created = client.request("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    assert_eq!(
        created["data"]["thinkingLevel"],
        json!("low"),
        "the parent starts at low: {created}"
    );
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["activeSessionId"].as_str())
        .expect("session id")
        .to_string();
    let persisted_id = created["data"]["sessionId"]
        .as_str()
        .expect("persisted session id")
        .to_string();
    Harness {
        dir,
        agent_dir,
        session_dir,
        supervisor,
        client,
        session_id,
        persisted_id,
    }
}

impl Harness {
    /// The parent's session file (the child create's parentSessionPath).
    fn session_file(&self) -> PathBuf {
        std::fs::read_dir(&self.session_dir)
            .expect("read session dir")
            .flatten()
            .map(|entry| entry.path())
            .find(|path| path.extension().and_then(|e| e.to_str()) == Some("jsonl"))
            .expect("the parent session file (create persists it)")
    }
}

/// The spawn-child / raise / watch-the-roster repro: the raise must reach
/// the roster entries the agents view renders, for a spawned subagent and
/// the top-level session both — and a model switch that clamps the level
/// flushes the roster too (TS flushes `set_model` explicitly).
#[test]
fn thinking_level_changes_reach_the_roster_push() {
    let mut harness = setup("thinking-roster");
    let parent_id = harness.session_id.clone();
    let session_file = harness.session_file();

    // Spawn a subagent at low thinking (the spawn create carries the level
    // into the child's summary, so the roster snapshot starts at low).
    let child_dir = harness.agent_dir.join("subagents");
    std::fs::create_dir_all(&child_dir).expect("child dir");
    harness.client.send_command(
        "cc",
        json!({
            "type": "create",
            "name": "roster-child",
            "config": {
                "cwd": harness.dir.path().to_string_lossy(),
                "sessionDir": child_dir.to_string_lossy(),
                "provider": "battery",
                "model": "mock-1",
                "thinking": "low",
                "rlmDepth": 1,
                "parentSessionPath": session_file.to_string_lossy(),
                "executionMode": "print",
            },
            "runtimeMetadata": {
                "kind": "subagent",
                "rlmChildId": "child-1",
                "rlmDepth": 1,
                "parentSessionFile": session_file.to_string_lossy(),
                "parentSessionId": harness.persisted_id,
                "parentActiveSessionId": parent_id,
            },
        }),
    );
    let child_created = harness.client.request("cc");
    assert_eq!(
        child_created["success"], true,
        "subagent create failed: {child_created}"
    );
    assert_eq!(
        child_created["data"]["thinkingLevel"],
        json!("low"),
        "the child spawns at low: {child_created}"
    );
    let child_id = child_created["data"]["id"]
        .as_str()
        .or_else(|| child_created["data"]["activeSessionId"].as_str())
        .expect("child active session id")
        .to_string();

    // Probe: a plain child read answers before the switch (routing sanity).
    harness.client.send_command(
        "gs-child",
        json!({ "type": "get_state", "activeSessionId": child_id }),
    );
    let probed = harness.client.request("gs-child");
    assert_eq!(probed["success"], true, "child get_state failed: {probed}");

    // Subscribe: the snapshot carries both rows at low.
    harness
        .client
        .send_command("rs", json!({ "type": "roster_subscribe" }));
    let subscribed = harness.client.request("rs");
    assert_eq!(
        subscribed["success"], true,
        "subscribe failed: {subscribed}"
    );
    let child_row = subscribed["data"]["roster"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .find(|entry| entry["summary"]["rlmChildId"] == json!("child-1"))
        .expect("the child row in the roster snapshot");
    assert_eq!(
        child_row["summary"]["thinkingLevel"],
        json!("low"),
        "the snapshot child row is at low: {child_row}"
    );
    let parent_row = subscribed["data"]["roster"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .find(|entry| entry["summary"]["activeSessionId"] == parent_id.as_str())
        .expect("the parent row in the roster snapshot");
    assert_eq!(
        parent_row["summary"]["thinkingLevel"],
        json!("low"),
        "the snapshot parent row is at low: {parent_row}"
    );

    // Raise the child: the roster push must carry the raised level without
    // a turn (the agents view's Model column reads `model:level` right
    // after the raise, never the stale low).
    harness.client.send_command(
        "stl-child",
        json!({ "type": "set_thinking_level", "activeSessionId": child_id, "level": "high" }),
    );
    let raised = harness.client.request("stl-child");
    assert_eq!(
        raised["success"], true,
        "child set_thinking_level failed: {raised}"
    );
    let update = harness.client.next_roster_update(|line| {
        line["changed"].as_array().is_some_and(|entries| {
            entries.iter().any(|entry| {
                entry["summary"]["rlmChildId"] == json!("child-1")
                    && entry["summary"]["thinkingLevel"] == json!("high")
            })
        })
    });
    assert!(
        update["changed"]
            .as_array()
            .is_some_and(|entries| entries.iter().all(|entry| {
                entry["summary"]["rlmChildId"] != json!("child-1")
                    || entry["status"] == json!("idle")
            })),
        "the raised child stays idle in the roster push: {update}"
    );

    // The top-level raise rides the same push path.
    harness.client.send_command(
        "stl-parent",
        json!({ "type": "set_thinking_level", "activeSessionId": parent_id, "level": "high" }),
    );
    let raised = harness.client.request("stl-parent");
    assert_eq!(
        raised["success"], true,
        "parent set_thinking_level failed: {raised}"
    );
    harness.client.next_roster_update(|line| {
        line["changed"].as_array().is_some_and(|entries| {
            entries.iter().any(|entry| {
                entry["summary"]["activeSessionId"] == parent_id.as_str()
                    && entry["summary"]["thinkingLevel"] == json!("high")
            })
        })
    });

    // A model switch that clamps the level flushes the roster too: the
    // non-reasoning model forces `off`, and the push carries BOTH the new
    // model and the clamped level (TS `set_model` schedules the flush).
    harness.client.send_command(
        "sm",
        json!({
            "type": "set_model",
            "activeSessionId": parent_id,
            "provider": "battery",
            "modelId": "mock-2",
        }),
    );
    let switched = harness.client.request("sm");
    assert_eq!(switched["success"], true, "set_model failed: {switched}");
    let update = harness.client.next_roster_update(|line| {
        line["changed"].as_array().is_some_and(|entries| {
            entries.iter().any(|entry| {
                entry["summary"]["activeSessionId"] == parent_id.as_str()
                    && entry["summary"]["model"]["id"] == json!("mock-2")
                    && entry["summary"]["thinkingLevel"] == json!("off")
            })
        })
    });
    assert!(
        update["changed"]
            .as_array()
            .is_some_and(|entries| entries.iter().all(|entry| {
                entry["summary"]["activeSessionId"] != parent_id.as_str()
                    || entry["status"] == json!("idle")
            })),
        "the switched parent stays idle in the roster push: {update}"
    );

    // The durable row the raise persisted backs the saved surfaces (the
    // agents view's saved-catalog rows read the same level).
    let entries: Vec<Value> = std::fs::read_to_string(&session_file)
        .expect("read session file")
        .lines()
        .map(|line| serde_json::from_str(line).expect("parse entry"))
        .collect();
    assert!(
        entries
            .iter()
            .any(|entry| entry["type"] == "thinking_level_change"
                && entry["thinkingLevel"] == json!("high")),
        "the raise persisted its thinking_level_change row"
    );
}

/// An unchanged request answers success without a roster push: the flush
/// is the effective-change trigger, not the command itself.
#[test]
fn unchanged_thinking_level_answers_without_a_roster_push() {
    let mut harness = setup("thinking-roster-quiet");
    let parent_id = harness.session_id.clone();

    harness
        .client
        .send_command("rs", json!({ "type": "roster_subscribe" }));
    let subscribed = harness.client.request("rs");
    assert_eq!(
        subscribed["success"], true,
        "subscribe failed: {subscribed}"
    );

    // Drain the create's benign roster pushes first (the `SessionCreated`
    // re-registration refresh carries the persisted session id), so the
    // quiet window below only measures `set_thinking_level` pushes.
    harness
        .client
        .drain_roster_pushes(Duration::from_millis(600));

    // low again: no change, success, and no push inside the quiet window.
    harness.client.send_command(
        "stl-same",
        json!({ "type": "set_thinking_level", "activeSessionId": parent_id, "level": "low" }),
    );
    let applied = harness.client.request("stl-same");
    assert_eq!(
        applied["success"], true,
        "unchanged set_thinking_level failed: {applied}"
    );
    let pushed = harness
        .client
        .roster_pushes_within(Duration::from_millis(1500));
    assert!(
        pushed.is_empty(),
        "an unchanged level must not flush the roster (only effective changes do): {pushed:?}"
    );
}
