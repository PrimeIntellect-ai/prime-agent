//! End-to-end RPC-mode verification: the real binary serves the TS
//! `modes/rpc` JSONL command surface over stdio, driven by the scripted
//! faux provider. Covers the protocol contract (response shapes, parse
//! and unknown-command errors, prompt-response event ordering), the core
//! command set (state, model/thinking, queue modes, compaction, session
//! tree, name/stats), the TS in-process daemon-mode errors, and the
//! lifecycle (stdin close settles and exits 0).

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// The child plus the tempdir it runs in: the tempdir must outlive the
/// child process (its cwd), so it is held on the struct.
struct RpcChild {
    child: Child,
    /// `Some` while the pipe is open: the EOF tests take it (the drop
    /// closes the child's stdin).
    stdin: Option<std::process::ChildStdin>,
    lines: Receiver<String>,
    next_id: u64,
    /// Held (never read) so the child's cwd directory outlives the
    /// process; dropping the tempdir deletes it and the child's
    /// `current_dir` fails.
    _home: tempfile::TempDir,
    spawn_stderr: Option<std::process::ChildStderr>,
    /// Drain the child's stderr AFTER the Drop kills and reaps it (a
    /// read on a live pipe blocks until exit; the sibling ACP harness
    /// reads post-kill).
    drain_stderr_on_drop: bool,
}

impl RpcChild {
    fn spawn(args: &[&str], script: &Value) -> RpcChild {
        Self::spawn_seeded(args, script, None)
    }

    /// Spawn with a seeded `models.json` (the registry catalog the
    /// available/set-model surfaces compose: the faux provider needs its
    /// provider entry + key to pass the registry's configured-auth gate,
    /// the same shape the daemon harness seeds).
    fn spawn_seeded(args: &[&str], script: &Value, models: Option<Value>) -> RpcChild {
        let home = tempfile::TempDir::new().unwrap();
        if let Some(models) = models {
            let agent_dir = home.path().join("agent");
            std::fs::create_dir_all(&agent_dir).unwrap();
            std::fs::write(agent_dir.join("models.json"), models.to_string()).unwrap();
        }
        let bin = env!("CARGO_BIN_EXE_prime-agent");
        let mut child = Command::new(bin)
            .args(args)
            .env("HOME", home.path())
            .env("PRIME_AGENT_AGENT_DIR", home.path().join("agent"))
            .env("PRIME_AGENT_FAUX_SCRIPT", script.to_string())
            .current_dir(home.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("binary present");
        let stdin = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");
        let (tx, lines) = channel();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        if tx.send(line).is_err() {
                            return;
                        }
                    }
                    Err(_) => return,
                }
            }
        });
        RpcChild {
            child,
            stdin: Some(stdin),
            lines,
            next_id: 0,
            _home: home,
            spawn_stderr: Some(stderr),
            drain_stderr_on_drop: false,
        }
    }

    fn send(&mut self, frame: Value) {
        let mut line = serde_json::to_string(&frame).unwrap();
        line.push('\n');
        let stdin = self.stdin.as_mut().expect("stdin piped");
        stdin.write_all(line.as_bytes()).unwrap();
        stdin.flush().unwrap();
    }

    fn command(&mut self, command: &Value) -> String {
        self.next_id += 1;
        let id = format!("t-{}", self.next_id);
        let mut frame = command.clone();
        frame["id"] = json!(id);
        self.send(frame);
        id
    }

    /// Read frames until the response `id` answers; returns the response
    /// with the events seen before it, in order.
    fn wait_response(&mut self, id: &str, timeout: Duration) -> (Value, Vec<Value>) {
        let deadline = Instant::now() + timeout;
        let mut events = Vec::new();
        loop {
            let timeout_left = deadline.saturating_duration_since(Instant::now());
            if timeout_left.is_zero() {
                panic!("timed out waiting for response {id} (events: {events:?})");
            }
            match self.lines.recv_timeout(timeout_left) {
                Ok(line) => {
                    let frame: Value = serde_json::from_str(&line).expect("valid JSON line");
                    if frame.get("type").and_then(Value::as_str) == Some("response")
                        && frame.get("id").and_then(Value::as_str) == Some(id)
                    {
                        return (frame, events);
                    }
                    events.push(frame);
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    panic!("timed out waiting for response {id} (events: {events:?})")
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    panic!("rpc child stdout closed before response {id}")
                }
            }
        }
    }

    /// Read frames until one event of `event_type` arrives (the
    /// event-gated wait: never a fixed sleep).
    fn wait_event(&mut self, event_type: &str, timeout: Duration) -> Value {
        let deadline = Instant::now() + timeout;
        loop {
            let timeout_left = deadline.saturating_duration_since(Instant::now());
            if timeout_left.is_zero() {
                panic!("timed out waiting for event {event_type}");
            }
            match self.lines.recv_timeout(timeout_left) {
                Ok(line) => {
                    let frame: Value = serde_json::from_str(&line).expect("valid JSON line");
                    if frame.get("type").and_then(Value::as_str) == Some(event_type) {
                        return frame;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    panic!("timed out waiting for event {event_type}")
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    panic!("rpc child stdout closed before event {event_type}")
                }
            }
        }
    }

    fn request(&mut self, command: &Value) -> Value {
        let id = self.command(command);
        let (response, _) = self.wait_response(&id, TIMEOUT);
        response
    }

    /// Log the child's stderr once the Drop reaps it (a live read would
    /// block until exit; the drain moves to the post-kill site like the
    /// sibling ACP harness).
    fn drain_stderr(&mut self) {
        self.drain_stderr_on_drop = true;
    }
}

impl Drop for RpcChild {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if self.drain_stderr_on_drop {
            if let Some(mut stderr) = self.spawn_stderr.take() {
                let mut text = String::new();
                let _ = stderr.read_to_string(&mut text);
                if !text.is_empty() {
                    eprintln!("RPC child stderr: {text}");
                }
            }
        }
    }
}

const TIMEOUT: Duration = Duration::from_secs(60);

fn turn_script(steps: Value) -> Value {
    json!({ "responses": steps })
}

/// The mode answers `get_state` for a fresh session: the TS
/// `RpcSessionState` fields, an idle queue projection, and no goal.
#[test]
fn rpc_get_state_answers_the_fresh_session() {
    let mut client = RpcChild::spawn(
        &["--mode", "rpc", "--no-session"],
        &turn_script(json!(["unused"])),
    );
    let response = client.request(&json!({ "type": "get_state" }));
    assert_eq!(response["success"], true, "the response: {response}");
    let data = &response["data"];
    assert_eq!(data["isStreaming"], false);
    assert_eq!(data["isCompacting"], false);
    assert!(
        data["model"]["id"].is_string(),
        "the resolved model rides the state"
    );
    assert!(data["thinkingLevel"].is_string());
    assert_eq!(data["messageCount"], 0);
    assert_eq!(data["sessionActions"]["queuedCount"], 0);
    assert_eq!(data["sessionActions"]["steering"], json!([]));
    assert_eq!(data["sessionActions"]["followUps"], json!([]));
    assert_eq!(data["goal"]["active"], false);
    assert!(
        data.get("sessionFile").is_none(),
        "--no-session keeps the session in memory (no sessionFile key)"
    );
    assert!(data["sessionId"].is_string());
    client.drain_stderr();
}

/// The prompt response precedes the turn's stream events (TS
/// `promptResponsePending` buffering), and the turn settles with the
/// full agent-event sequence.
#[test]
fn rpc_prompt_streams_events_after_the_response() {
    let mut client = RpcChild::spawn(
        &["--mode", "rpc", "--no-session"],
        &turn_script(json!(["first reply"])),
    );
    let id = client.command(&json!({ "type": "prompt", "message": "hi" }));
    let (response, before) = client.wait_response(&id, TIMEOUT);
    assert_eq!(response["success"], true, "the response: {response}");
    assert!(
        response.get("data").is_none(),
        "prompt answers without a data key (TS success(id, command))"
    );
    assert!(
        before.is_empty(),
        "the prompt response precedes every turn event: {before:?}"
    );
    // The turn's frames arrive after the response, in the loop's order.
    // The first-turn harness digest rides ahead as its own custom row
    // (the port's in-context digest), so the first `message_start` may
    // be the digest row's: the reply's start is the first ASSISTANT
    // one.
    let deadline = Instant::now() + TIMEOUT;
    let start = loop {
        let frame = client.wait_event("message_start", TIMEOUT);
        if frame["message"]["role"] == "assistant" {
            break frame;
        }
        assert!(Instant::now() < deadline, "the assistant start never came");
    };
    let end = client.wait_event("agent_end", TIMEOUT);
    assert!(
        end["messages"]
            .as_array()
            .is_some_and(|messages| !messages.is_empty()),
        "agent_end carries the run's messages"
    );
    client.drain_stderr();
}

/// A malformed line and an unknown command answer the TS protocol
/// errors (the `parse` command name and the `Unknown command` text).
#[test]
fn rpc_parse_and_unknown_command_errors() {
    let mut client = RpcChild::spawn(
        &["--mode", "rpc", "--no-session"],
        &turn_script(json!(["unused"])),
    );
    // A non-object line answers the parse error (no id to match on, so
    // match the command name).
    client.send(json!("not an object"));
    let deadline = Instant::now() + TIMEOUT;
    let parse_error = loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let frame = client.lines.recv_timeout(left).expect("a frame");
        let frame: Value = serde_json::from_str(&frame).expect("valid JSON line");
        if frame.get("type").and_then(Value::as_str) == Some("response")
            && frame.get("command").and_then(Value::as_str) == Some("parse")
        {
            break frame;
        }
    };
    assert_eq!(parse_error["success"], false);
    assert_eq!(
        parse_error["error"],
        "Invalid command: expected an object with a string type"
    );
    client.send(json!({ "type": "definitely_not_a_command" }));
    let deadline = Instant::now() + TIMEOUT;
    let unknown = loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let frame = client.lines.recv_timeout(left).expect("a frame");
        let frame: Value = serde_json::from_str(&frame).expect("valid JSON line");
        if frame.get("command").and_then(Value::as_str) == Some("definitely_not_a_command") {
            break frame;
        }
    };
    assert_eq!(unknown["success"], false);
    assert_eq!(
        unknown["error"],
        "Unknown command: definitely_not_a_command"
    );
    client.drain_stderr();
}

/// Steer and follow-up queue behind a running turn; abort settles it;
/// the queued steer runs as the next turn.
#[test]
fn rpc_steer_and_follow_up_queue_then_abort() {
    let script = json!({
        "responses": [
            { "text": "slow turn", "delayMs": 900 },
            { "text": "continue reply" },
            { "text": "steer answer" },
            { "text": "follow-up answer" },
        ],
    });
    let mut client = RpcChild::spawn(&["--mode", "rpc", "--no-session"], &script);
    // One-at-a-time steering (the settings default is "all": a steer
    // mid-turn folds into the RUNNING request instead of queueing, so
    // the queue projections this test observes need the deterministic
    // mode first — TS `setSteeringMode("one-at-a-time")`).
    let mode = client.request(&json!({ "type": "set_steering_mode", "mode": "one-at-a-time" }));
    assert_eq!(mode["success"], true, "the mode is set: {mode}");
    let response = client.request(&json!({ "type": "prompt", "message": "go" }));
    assert_eq!(response["success"], true);
    // Queue while the delayed turn is still open (admission returns
    // before the turn settles; the delayMs keeps it running).
    let steer = client.request(&json!({ "type": "steer", "message": "steer this" }));
    assert_eq!(steer["success"], true, "steer queues: {steer}");
    let follow_up = client.request(&json!({ "type": "follow_up", "message": "fu this" }));
    assert_eq!(follow_up["success"], true);
    client.wait_event("message_start", TIMEOUT);
    let state = client.request(&json!({ "type": "get_state" }));
    assert_eq!(state["data"]["isStreaming"], true);
    assert_eq!(state["data"]["sessionActions"]["queuedCount"], 2);
    assert_eq!(
        state["data"]["sessionActions"]["steering"],
        json!(["steer this"]),
        "the queue projection carries the queued previews"
    );
    let aborted = client.request(&json!({ "type": "abort" }));
    assert_eq!(aborted["success"], true);
    // The abort settles the delayed turn and suspends queued delivery
    // (TS `requestAbort`): the queued rows stay queued.
    client.wait_event("agent_end", TIMEOUT);
    let parked = client.request(&json!({ "type": "get_state" }));
    assert_eq!(
        parked["data"]["sessionActions"]["queuedCount"], 2,
        "the abort parks the queued rows: {parked}"
    );
    // The next prompt resumes the pump: the queued steer delivers as a
    // turn on the second response step, the queued follow-up on the
    // third, after the prompt's own turn.
    let second = client.request(&json!({ "type": "prompt", "message": "continue" }));
    assert_eq!(second["success"], true);
    client.wait_event("agent_end", TIMEOUT);
    client.wait_event("agent_end", TIMEOUT);
    client.wait_event("agent_end", TIMEOUT);
    let text = client.request(&json!({ "type": "get_last_assistant_text" }));
    assert_eq!(
        text["data"]["text"], "follow-up answer",
        "the queued follow-up ran last: {text}"
    );
    client.drain_stderr();
}

/// `set_thinking_level` applies and emits `thinking_level_changed`;
/// `cycle_thinking_level` steps through the supported levels (the faux
/// reasoning model).
#[test]
fn rpc_thinking_level_set_and_cycle() {
    let script = json!({ "responses": ["unused"], "reasoning": true });
    let mut client = RpcChild::spawn(&["--mode", "rpc", "--no-session"], &script);
    // The changed event lands BEFORE the response (the handler publishes
    // during the command): assert it among the pre-response frames
    // instead of waiting for a later copy that never comes.
    let id = client.command(&json!({ "type": "set_thinking_level", "level": "high" }));
    let (response, before) = client.wait_response(&id, TIMEOUT);
    assert_eq!(response["success"], true, "the response: {response}");
    assert!(
        response.get("data").is_none(),
        "set_thinking_level answers without data"
    );
    let changed = before
        .iter()
        .find(|frame| {
            frame.get("type").and_then(serde_json::Value::as_str) == Some("thinking_level_changed")
        })
        .expect("the changed event precedes the response");
    assert_eq!(changed["level"], "high");
    let state = client.request(&json!({ "type": "get_state" }));
    assert_eq!(state["data"]["thinkingLevel"], "high");
    let cycled = client.request(&json!({ "type": "cycle_thinking_level" }));
    assert_eq!(cycled["success"], true);
    assert!(
        cycled["data"]["level"].is_string(),
        "the cycle answers the next level: {cycled}"
    );
    let invalid = client.request(&json!({ "type": "set_thinking_level", "level": "bogus" }));
    assert_eq!(invalid["success"], false);
    assert!(
        invalid["error"]
            .as_str()
            .unwrap()
            .starts_with("Invalid thinking level \"bogus\". Valid values:"),
        "the TS invalid-level error text: {invalid}"
    );
    client.drain_stderr();
}

/// `compact` on a fresh session answers the TS skip error, with the
/// compaction frames around it.
#[test]
fn rpc_compact_answers_the_ts_skip_error() {
    let mut client = RpcChild::spawn(
        &["--mode", "rpc", "--no-session"],
        &turn_script(json!(["unused"])),
    );
    let id = client.command(&json!({ "type": "compact" }));
    let (response, events) = client.wait_response(&id, TIMEOUT);
    assert_eq!(response["success"], false, "the response: {response}");
    assert_eq!(
        response["error"],
        "Session is too short to compact — try again once it grows"
    );
    let types: Vec<&str> = events
        .iter()
        .filter_map(|event| event.get("type").and_then(Value::as_str))
        .collect();
    assert_eq!(
        types,
        vec!["compaction_start", "compaction_end"],
        "the compaction frames publish around the skip error"
    );
    assert_eq!(
        events[1]["result"],
        Value::Null,
        "a skipped compaction carries no result"
    );
    client.drain_stderr();
}

/// The daemon-mode families answer the exact TS in-process errors; the
/// list/get commands answer their TS empty shapes.
#[test]
fn rpc_daemon_mode_families_answer_the_ts_inprocess_semantics() {
    let mut client = RpcChild::spawn(
        &["--mode", "rpc", "--no-session"],
        &turn_script(json!(["unused"])),
    );
    let bash = client.request(&json!({ "type": "bash", "command": "echo hi" }));
    assert_eq!(bash["success"], false);
    assert!(
        bash["error"]
            .as_str()
            .unwrap()
            .starts_with("Bash execution requires"),
        "the bash gap names its backend: {bash}"
    );
    let send = client.request(&json!(
        { "type": "send_message", "targetActiveSessionId": "x", "message": "hi" }
    ));
    assert_eq!(send["error"], "Agent messaging requires daemon mode");
    let schedule =
        client.request(&json!({ "type": "add_schedule", "schedule": "every 5m", "prompt": "hi" }));
    assert_eq!(schedule["error"], "Cron jobs require daemon mode");
    let heartbeat =
        client.request(&json!({ "type": "set_heartbeat", "schedule": "every 5m", "prompt": "hi" }));
    assert_eq!(heartbeat["error"], "Heartbeats require daemon mode");
    let observe = client.request(&json!({ "type": "observe", "activeSessionId": "nope" }));
    assert_eq!(observe["error"], "Unknown active session: nope");
    let jobs = client.request(&json!({ "type": "list_schedules" }));
    assert_eq!(jobs["data"], json!({ "jobs": [] }));
    let heartbeats = client.request(&json!({ "type": "list_heartbeats" }));
    assert_eq!(heartbeats["data"], json!({ "heartbeats": [] }));
    let get_heartbeat = client.request(&json!({ "type": "get_heartbeat" }));
    assert_eq!(get_heartbeat["data"], json!({ "heartbeat": null }));
    client.drain_stderr();
}

/// `set_session_name` persists the name and emits
/// `session_info_changed`; an empty name answers the TS error.
#[test]
fn rpc_set_session_name_round_trip() {
    let mut client = RpcChild::spawn(
        &["--mode", "rpc", "--no-session"],
        &turn_script(json!(["unused"])),
    );
    // The changed event lands BEFORE the response: assert it among the
    // pre-response frames (a later wait would never see a copy).
    let id = client.command(&json!({ "type": "set_session_name", "name": "  my session  " }));
    let (response, before) = client.wait_response(&id, TIMEOUT);
    assert_eq!(response["success"], true, "the response: {response}");
    let changed = before
        .iter()
        .find(|frame| {
            frame.get("type").and_then(serde_json::Value::as_str) == Some("session_info_changed")
        })
        .expect("the changed event precedes the response");
    assert_eq!(changed["name"], "my session");
    let state = client.request(&json!({ "type": "get_state" }));
    assert_eq!(state["data"]["sessionName"], "my session");
    let empty = client.request(&json!({ "type": "set_session_name", "name": "   " }));
    assert_eq!(empty["error"], "Session name cannot be empty");
    client.drain_stderr();
}

/// `get_fork_messages` lists the user rows; `fork` branches the session
/// at the entry's parent leaf and moves the connection onto the fork
/// (the persisted session-file path).
#[test]
fn rpc_fork_messages_and_fork_swap() {
    let script = turn_script(json!(["one", "two"]));
    let mut client = RpcChild::spawn(&["--mode", "rpc"], &script);
    for message in ["first turn", "second turn"] {
        let response = client.request(&json!({ "type": "prompt", "message": message }));
        assert_eq!(response["success"], true, "the response: {response}");
        client.wait_event("agent_end", TIMEOUT);
    }
    let forks = client.request(&json!({ "type": "get_fork_messages" }));
    let messages = forks["data"]["messages"].as_array().cloned().unwrap();
    assert_eq!(
        messages
            .iter()
            .map(|message| message["text"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["first turn", "second turn"],
        "the user rows in file order"
    );
    assert!(
        messages
            .iter()
            .all(|message| message["entryId"].as_str().is_some_and(|id| !id.is_empty())),
        "each row carries its entry id"
    );
    let before = client.request(&json!({ "type": "get_state" }));
    let first_entry_id = messages[0]["entryId"].as_str().unwrap().to_string();
    let fork = client.request(&json!({ "type": "fork", "entryId": first_entry_id }));
    assert_eq!(fork["success"], true, "the fork response: {fork}");
    assert_eq!(fork["data"]["text"], "first turn");
    assert_eq!(fork["data"]["cancelled"], false);
    let after = client.request(&json!({ "type": "get_state" }));
    assert_ne!(
        before["data"]["sessionId"], after["data"]["sessionId"],
        "the fork is a new session file"
    );
    client.drain_stderr();
}

/// `new_session` replaces the runtime with a fresh session.
#[test]
fn rpc_new_session_swaps_the_engine() {
    let script = turn_script(json!(["one", "unused"]));
    let mut client = RpcChild::spawn(&["--mode", "rpc"], &script);
    let response = client.request(&json!({ "type": "prompt", "message": "hi" }));
    assert_eq!(response["success"], true);
    client.wait_event("agent_end", TIMEOUT);
    let before = client.request(&json!({ "type": "get_state" }));
    let fresh = client.request(&json!({ "type": "new_session" }));
    assert_eq!(fresh["data"], json!({ "cancelled": false }));
    let after = client.request(&json!({ "type": "get_state" }));
    assert_ne!(
        before["data"]["sessionId"], after["data"]["sessionId"],
        "new_session adopts a fresh session"
    );
    assert_eq!(after["data"]["messageCount"], 0);
    client.drain_stderr();
}

/// `get_available_models` answers the refreshed catalog (the faux
/// registration's model).
#[test]
fn rpc_get_available_models_lists_the_catalog() {
    // The registry composes models.json: the faux provider needs its
    // provider entry (api + key + model) to pass the configured-auth
    // gate the available catalog filters on (the daemon harness seeds
    // the same shape).
    let mut client = RpcChild::spawn_seeded(
        &["--mode", "rpc", "--no-session"],
        &turn_script(json!(["unused"])),
        Some(json!({
            "providers": {
                "faux": {
                    "api": "faux",
                    "baseUrl": "http://localhost:0",
                    "apiKey": "sk-faux",
                    "models": [{
                        "id": "faux-1",
                        "name": "Faux Model",
                        "contextWindow": 100_000,
                        "maxTokens": 4_096,
                    }],
                }
            }
        })),
    );
    let response = client.request(&json!({ "type": "get_available_models" }));
    assert_eq!(response["success"], true, "the response: {response}");
    let models = response["data"]["models"].as_array().cloned().unwrap();
    assert!(
        models.iter().any(|model| model["id"] == "faux-1"),
        "the faux model is available: {models:?}"
    );
    client.drain_stderr();
}

/// Stdin close settles the running turn and exits 0 (TS `onInputEnd`).
#[test]
fn rpc_eof_settles_and_exits_zero() {
    let script = json!({
        "responses": [
            { "text": "slow", "delayMs": 300 },
            { "text": "after" },
        ],
    });
    let mut client = RpcChild::spawn(&["--mode", "rpc", "--no-session"], &script);
    let response = client.request(&json!({ "type": "prompt", "message": "go" }));
    assert_eq!(response["success"], true);
    client.wait_event("message_start", TIMEOUT);
    // Close stdin mid-turn: the child settles the turn and exits 0.
    drop(client.stdin.take());
    let status = client
        .child
        .wait()
        .expect("the child exits when stdin closes");
    assert!(
        status.success(),
        "stdin close settles the turn and exits 0 (status {status})"
    );
    client.spawn_stderr = None;
}

/// The stats command answers the TS `SessionStats` shape over the live
/// messages.
#[test]
fn rpc_get_session_stats_answers_the_ts_shape() {
    let script = turn_script(json!(["one"]));
    let mut client = RpcChild::spawn(&["--mode", "rpc"], &script);
    let response = client.request(&json!({ "type": "prompt", "message": "hi" }));
    assert_eq!(response["success"], true);
    client.wait_event("agent_end", TIMEOUT);
    let stats = client.request(&json!({ "type": "get_session_stats" }));
    assert_eq!(stats["success"], true, "the stats response: {stats}");
    let data = &stats["data"];
    assert_eq!(data["userMessages"], 1);
    assert_eq!(data["assistantMessages"], 1);
    assert_eq!(data["totalMessages"], 2);
    assert!(data["sessionId"].is_string());
    assert!(
        data["sessionFile"].is_string(),
        "persisted session reports its file"
    );
    assert!(data["tokens"].is_object());
    client.drain_stderr();
}

/// The mode must never surface the pre-port stub message: `--mode rpc`
/// answers the protocol, so the misleading missing-subsystem line is
/// gone (the regression test for the S5 stub).
#[test]
fn rpc_mode_never_prints_the_missing_subsystem_stub() {
    let mut client = RpcChild::spawn(
        &["--mode", "rpc", "--no-session"],
        &turn_script(json!(["unused"])),
    );
    // Any answered command proves the transport is live; the stub would
    // exit 1 immediately with the misleading error on stderr/stdout.
    let response = client.request(&json!({ "type": "get_state" }));
    assert_eq!(response["success"], true);
    drop(client.stdin.take());
    let status = client.child.wait().expect("exit");
    assert!(status.success(), "the mode serves the protocol: {status}");
    client.spawn_stderr = None;
}
