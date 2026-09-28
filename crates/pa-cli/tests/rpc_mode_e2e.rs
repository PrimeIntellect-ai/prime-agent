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
    /// Held so the child's cwd directory outlives the process; dropping
    /// the tempdir deletes it and the child's `current_dir` fails (the
    /// lease tests also read the agent dir off it).
    home: tempfile::TempDir,
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
            .env("PRIME_AGENT_CODING_AGENT_DIR", home.path().join("agent"))
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
            home,
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
            assert!(
                !timeout_left.is_zero(),
                "timed out waiting for response {id} (events: {events:?})"
            );
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
            assert!(
                !timeout_left.is_zero(),
                "timed out waiting for event {event_type}"
            );
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

    /// The agent dir the child runs with (the harness seeds
    /// `PRIME_AGENT_CODING_AGENT_DIR` here): the lease owner records
    /// live under its `session-leases` tree.
    fn agent_dir(&self) -> std::path::PathBuf {
        self.home.path().join("agent")
    }
}

/// The session files holding a runtime lease right now (the owner
/// records the fresh/fork paths acquire before the engine can write).
fn leased_session_files(agent_dir: &std::path::Path) -> Vec<String> {
    let mut leased = Vec::new();
    let Ok(entries) = std::fs::read_dir(agent_dir.join("session-leases")) else {
        return leased;
    };
    for entry in entries.flatten() {
        let Ok(text) = std::fs::read_to_string(entry.path().join("owner.json")) else {
            continue;
        };
        let Ok(owner) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if let Some(path) = owner.get("sessionPath").and_then(Value::as_str) {
            leased.push(path.to_string());
        }
    }
    leased
}

/// Canonical-path comparison (the owner record stores the canonical
/// path; the test-side strings come from the same tree, but symlinks on
/// the host must not mask the match).
fn is_leased(leased: &[String], session_file: &str) -> bool {
    let session_file = std::path::Path::new(session_file);
    leased.iter().any(|leased| {
        std::fs::canonicalize(leased).ok() == std::fs::canonicalize(session_file).ok()
    })
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
    loop {
        let frame = client.wait_event("message_start", TIMEOUT);
        if frame["message"]["role"] == "assistant" {
            break;
        }
        assert!(Instant::now() < deadline, "the assistant start never came");
    }
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

/// Steer and follow-up queue behind a running turn; abort settles it
/// and parks the rows; the next prompt's run folds the parked steer
/// into its own turn and delivers the follow-up as its second turn
/// (TS `runLoop`'s run-start steering poll and post-turn follow-up
/// poll over the parked queues).
#[test]
fn rpc_steer_and_follow_up_queue_then_abort() {
    let script = json!({
        "responses": [
            { "text": "slow turn", "delayMs": 5000 },
            { "text": "continue reply" },
            { "text": "steer answer" },
        ],
    });
    let mut client = RpcChild::spawn(&["--mode", "rpc", "--no-session"], &script);
    // Arm the stderr drain up front: the Drop prints the child's stderr
    // when the test fails (a runtime-side panic or error line would
    // otherwise vanish with the pipe).
    client.drain_stderr();
    // One-at-a-time steering (the settings default is "all": a steer
    // mid-turn folds into the RUNNING request instead of queueing, so
    // the queue projections this test observes need the deterministic
    // mode first — TS `setSteeringMode("one-at-a-time")`).
    let mode = client.request(&json!({ "type": "set_steering_mode", "mode": "one-at-a-time" }));
    assert_eq!(mode["success"], true, "the mode is set: {mode}");
    let response = client.request(&json!({ "type": "prompt", "message": "go" }));
    assert_eq!(response["success"], true);
    // The response fires once the turn's run registers (TS
    // `preflightResult` — the admission-time contract), so from here
    // the turn is mid-LLM-call: the faux delayMs holds the stream
    // closed for 5000ms, and the run-start steering poll (the fold
    // window) already closed before the response. 1000ms in, both
    // queued rows sit in the queues — nothing polls them until the
    // turn ends.
    std::thread::sleep(Duration::from_millis(1000));
    let steer = client.request(&json!({ "type": "steer", "message": "steer this" }));
    assert_eq!(steer["success"], true, "steer queues: {steer}");
    let follow_up = client.request(&json!({ "type": "follow_up", "message": "fu this" }));
    assert_eq!(follow_up["success"], true);
    let state = client.request(&json!({ "type": "get_state" }));
    // The turn runs past its response (the admission returned at run
    // start; the faux delay still holds the stream closed) and both
    // rows queue behind it.
    assert_eq!(
        state["data"]["isStreaming"], true,
        "the turn is still running past the prompt response: {state}"
    );
    assert_eq!(
        state["data"]["sessionActions"]["queuedCount"], 2,
        "both rows queued while the turn runs its request: {state}"
    );
    assert_eq!(
        state["data"]["sessionActions"]["steering"],
        json!(["steer this"]),
        "the queue projection carries the queued previews"
    );
    let abort_id = client.command(&json!({ "type": "abort" }));
    let (aborted, before_abort) = client.wait_response(&abort_id, TIMEOUT);
    assert_eq!(aborted["success"], true);
    // The abort settles the running turn on its own task: the settle's
    // `agent_end` can land on the wire before or after the abort
    // response (the TS single-threaded reference always orders the
    // response first; the async port does not guarantee it) — accept
    // either ordering; an `agent_end` the response read consumed counts.
    if !before_abort
        .iter()
        .any(|frame| frame.get("type").and_then(Value::as_str) == Some("agent_end"))
    {
        client.wait_event("agent_end", TIMEOUT);
    }
    let parked = client.request(&json!({ "type": "get_state" }));
    assert_eq!(
        parked["data"]["sessionActions"]["queuedCount"], 2,
        "the abort parks the queued rows: {parked}"
    );
    // The next prompt resumes delivery and its run FOLDS the parked
    // rows (TS `runLoop`, agent-loop.ts): the run-start steering poll
    // folds the parked steer into the prompt's own turn's input
    // (`skip_initial=false` — the TS loop folds anything queued before
    // the turn starts), and the run's post-turn follow-up poll
    // delivers the parked follow-up as the run's second turn. One run,
    // two turns: the prompt's turn answers on the second script step,
    // the follow-up turn on the third, and the single `agent_end`
    // carries the whole folded run.
    let second = client.request(&json!({ "type": "prompt", "message": "continue" }));
    assert_eq!(second["success"], true);
    let end = client.wait_event("agent_end", TIMEOUT);
    let texts = end["messages"]
        .as_array()
        .expect("the run's messages on agent_end")
        .iter()
        .map(|message| {
            message["content"]
                .as_array()
                .and_then(|content| content.first())
                .and_then(|part| part.get("text"))
                .and_then(Value::as_str)
                .unwrap_or_default()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        texts,
        vec![
            "continue",
            "steer this",
            "continue reply",
            "fu this",
            "steer answer"
        ],
        "the folded run carries the parked rows in TS order: {end}"
    );
    let text = client.request(&json!({ "type": "get_last_assistant_text" }));
    assert_eq!(
        text["data"]["text"], "steer answer",
        "the folded follow-up turn ran last: {text}"
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

/// A fresh persisted session leases its eagerly selected file before
/// the engine can write it (the UNGATED runtime acquire — the env-gated
/// test helper answered `None` in production and left fresh sessions
/// unleased): the owner record exists while the engine is live.
#[test]
fn rpc_fresh_sessions_lease_their_files() {
    let mut client = RpcChild::spawn(&["--mode", "rpc"], &turn_script(json!(["one"])));
    let response = client.request(&json!({ "type": "prompt", "message": "hi" }));
    assert_eq!(response["success"], true);
    client.wait_event("agent_end", TIMEOUT);
    let stats = client.request(&json!({ "type": "get_session_stats" }));
    let session_file = stats["data"]["sessionFile"]
        .as_str()
        .expect("the persisted session reports its file")
        .to_string();
    let leased = leased_session_files(&client.agent_dir());
    assert!(
        is_leased(&leased, &session_file),
        "the fresh session's file is runtime-leased while the engine is live (leased: {leased:?})"
    );
    drop(client.stdin.take());
    let status = client.child.wait().expect("exit");
    assert!(status.success(), "eof settles the leased session: {status}");
    client.spawn_stderr = None;
}

/// The `--fork` copy leases its materialized file before the engine
/// writes it: another process resuming the new file can never become a
/// second writer while this engine appends (the source is only read).
#[test]
fn rpc_fork_leases_the_materialized_file() {
    let mut source = RpcChild::spawn(&["--mode", "rpc"], &turn_script(json!(["one"])));
    let response = source.request(&json!({ "type": "prompt", "message": "hi" }));
    assert_eq!(response["success"], true);
    source.wait_event("agent_end", TIMEOUT);
    let stats = source.request(&json!({ "type": "get_session_stats" }));
    let source_file = stats["data"]["sessionFile"]
        .as_str()
        .expect("the source session reports its file")
        .to_string();
    drop(source.stdin.take());
    let status = source.child.wait().expect("the source exits cleanly");
    assert!(status.success(), "the source session settles: {status}");
    source.spawn_stderr = None;

    let mut forked = RpcChild::spawn(
        &["--mode", "rpc", "--fork", &source_file],
        &turn_script(json!(["hi there"])),
    );
    let response = forked.request(&json!({ "type": "prompt", "message": "again" }));
    assert_eq!(response["success"], true);
    forked.wait_event("agent_end", TIMEOUT);
    let stats = forked.request(&json!({ "type": "get_session_stats" }));
    let forked_file = stats["data"]["sessionFile"]
        .as_str()
        .expect("the forked session reports its file")
        .to_string();
    assert_ne!(forked_file, source_file, "the fork materialized a new file");
    let leased = leased_session_files(&forked.agent_dir());
    assert!(
        is_leased(&leased, &forked_file),
        "the fork's materialized file is runtime-leased (leased: {leased:?})"
    );
    drop(forked.stdin.take());
    let status = forked.child.wait().expect("exit");
    assert!(status.success(), "eof settles the forked session: {status}");
    forked.spawn_stderr = None;
}

/// A FAILED whole-session replacement never strands the live session's
/// queued work: the running turn's post-turn steering fold drains the
/// parked row while the settle waits the turn out, and the re-armed
/// pump covers the rest (the pre-settle epoch bump retired the old
/// pump; the failure never owned the rows).
#[test]
fn rpc_failed_replacement_restarts_the_queue_pump() {
    let script = json!({ "responses": [
        { "text": "first answer", "delayMs": 300 },
        "steer answer",
    ]});
    let mut client = RpcChild::spawn(&["--mode", "rpc", "--no-session"], &script);
    let response = client.request(&json!({ "type": "prompt", "message": "go" }));
    assert_eq!(response["success"], true);
    client.wait_event("message_start", TIMEOUT);
    // The steer parks behind the running turn.
    let steer = client.request(&json!({ "type": "steer", "message": "steer me" }));
    assert_eq!(steer["success"], true, "the steer queues: {steer}");
    // The switch fails its assembly AFTER the settle: the crafted
    // header stores a cwd that no longer exists (a merely missing file
    // lazily opens as a new session instead), so the factory's
    // missing-cwd guard refuses deterministically. The replacement
    // retired the pump, the assembly failed, and the restart must hand
    // the parked rows back to a live pump.
    let bad_file = client.agent_dir().join("bad-cwd-session.jsonl");
    std::fs::write(
        &bad_file,
        concat!(
            "{\"type\":\"session\",\"id\":\"bad-cwd\",",
            "\"timestamp\":\"2026-09-26T00:00:00.000Z\",",
            "\"cwd\":\"/definitely/missing/project\"}\n"
        ),
    )
    .expect("write the crafted session");
    let bad = client.command(&json!({
        "type": "switch_session",
        "sessionPath": bad_file.to_string_lossy()
    }));
    client.drain_stderr();
    let (failed, before) = client.wait_response(&bad, TIMEOUT);
    assert_eq!(
        failed["success"], false,
        "the stale-cwd session fails the switch: {failed}"
    );
    let error = failed["error"].as_str().unwrap_or_default();
    assert!(
        error.contains("Stored session working directory does not exist"),
        "the failure is the crafted stale cwd, not an unrelated refusal: {failed}"
    );
    // The parked row must still deliver: the running turn's post-turn
    // steering fold drains it while the settle waits the turn out (its
    // agent_end lands BEFORE the switch's error response), or the
    // re-armed pump delivers after the failure — either order is the
    // contract, a failed replacement never strands the live session's
    // queued work.
    let steer_answer_landed = |frame: &Value| {
        if frame.get("type").and_then(Value::as_str) != Some("agent_end") {
            return false;
        }
        frame["messages"].as_array().is_some_and(|messages| {
            messages.iter().any(|message| {
                message["content"]
                    .as_array()
                    .and_then(|content| content.first())
                    .and_then(|part| part.get("text"))
                    .and_then(Value::as_str)
                    .is_some_and(|text| text.contains("steer answer"))
            })
        })
    };
    if before.iter().any(steer_answer_landed) {
        return;
    }
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let timeout_left = deadline.saturating_duration_since(Instant::now());
        assert!(
            !timeout_left.is_zero(),
            "no second turn: the parked steer stranded"
        );
        match client.lines.recv_timeout(timeout_left) {
            Ok(line) => {
                let frame: Value = serde_json::from_str(&line).expect("valid JSON line");
                if steer_answer_landed(&frame) {
                    break;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                panic!("the parked steer never delivered after the failed switch");
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                panic!("rpc child closed before the parked steer delivered");
            }
        }
    }
}

/// A signal exit during an in-flight whole-session replacement must not
/// queue behind the replacement's settle: the shutdown broadcast aborts
/// the running turn, the replacement refuses, and the 143 exit fires
/// long before the stalled model call would finish.
#[test]
fn rpc_sigterm_during_replacement_exits_promptly() {
    let script = json!({ "responses": [ { "text": "slow", "delayMs": 30_000 } ] });
    let mut client = RpcChild::spawn(&["--mode", "rpc", "--no-session"], &script);
    let response = client.request(&json!({ "type": "prompt", "message": "go" }));
    assert_eq!(response["success"], true);
    client.wait_event("message_start", TIMEOUT);
    // The replacement queues behind the running turn's settle; SIGTERM
    // must cut through both.
    client.send(json!({ "type": "new_session", "id": "t-replace" }));
    let status = std::process::Command::new("kill")
        .arg("-TERM")
        .arg(client.child.id().to_string())
        .status()
        .expect("send SIGTERM");
    assert!(status.success(), "the SIGTERM dispatch succeeded");
    // Event-gated wait: the stdout pipe closes exactly when the child
    // exits — well inside the faux turn's 30s hold.
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match client.lines.recv_timeout(Duration::from_millis(500)) {
            Ok(_) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                assert!(
                    Instant::now() < deadline,
                    "the signal exit queued behind the replacement's settle"
                );
            }
        }
    }
    let status = client.child.wait().expect("the signal exits the child");
    assert_eq!(status.code(), Some(143), "SIGTERM exits 143");
    client.spawn_stderr = None;
}

/// A deterministic large session fixture in the corpus row schema (the
/// bench generator's exact row shapes: the session header, the base
/// harness-digest rows, then user -> assistant(tool call) -> toolResult
/// turns with digest rows every 20 turns, and the final marker pair). A
/// resumable session whose compaction's pre-summarizer CPU span is
/// data-scaled — the same property the canonical 10MiB bench fixture
/// has, sized for the compaction-visibility oracles.
fn write_corpus_fixture(path: &std::path::Path, size_mib: usize) {
    let home = path.parent().unwrap().parent().unwrap();
    let mut rows: Vec<Value> = Vec::new();
    rows.push(json!({
        "type": "session", "id": "cvis-e2e-corpus", "version": 3,
        "timestamp": "2026-09-16T18:40:16.600Z",
        "cwd": home.display().to_string(), "rlmDepth": 0,
    }));
    let mut counter: u64 = 0;
    let mut parent = String::new();
    let entry = |counter: &mut u64, parent: &mut String, fields: Value| {
        *counter += 1;
        let id = format!("{:08x}", *counter);
        let mut row = fields;
        row["id"] = json!(id);
        row["parentId"] = json!(parent);
        row["timestamp"] = json!(format!(
            "2026-09-16T18:{:02}:{:02}.{:03}Z",
            (*counter / 60) % 60,
            *counter % 60,
            *counter % 1000
        ));
        *parent = id;
        row
    };
    for base in 0..11 {
        let row = entry(&mut counter, &mut parent, json!({
            "customType": "harness_digest",
            "content": format!(
                "[harness-digest] base note {base}: persistent state summary for the corpus."
            ),
            "type": "custom_message",
        }));
        rows.push(row);
    }
    // ~40KB of assistant text per turn keeps the fixture at `size_mib`
    // MiB over a few hundred turns (the bench corpus's per-turn scale).
    let paragraph = "Latency tools daemon terminal kernel parity settle memory viewport \
                     streaming cadence corpus sentinel transcript snapshot roster. "
        .repeat(10);
    let turn_text = paragraph.repeat(90);
    let per_turn = turn_text.len() + 1024;
    let turns = (size_mib * (1 << 20)) / per_turn;
    for turn in 0..turns {
        let row = entry(&mut counter, &mut parent, json!({
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": format!("please do task number {turn}") }],
                "timestamp": 1_789_584_016_603_i64 + turn as i64,
            },
            "type": "message",
        }));
        rows.push(row);
        let call_id = format!("call_{turn:06}");
        let row = entry(&mut counter, &mut parent, json!({
            "message": {
                "role": "assistant",
                "content": [
                    { "type": "thinking", "thinking": format!("task {turn}: run the corpus command") },
                    { "type": "text", "text": turn_text },
                ],
                "toolCalls": [{
                    "id": call_id,
                    "name": "ipython",
                    "arguments": { "code": format!("print('corpus {turn}')") },
                }],
                "api": "openai-completions",
                "provider": "prime-inference",
                "model": "mock-1",
                "usage": {
                    "input": 100, "output": 20, "cacheRead": 10, "cacheWrite": 0,
                    "totalTokens": 130,
                    "cost": { "input": 0.1, "output": 0.02, "cacheRead": 0, "cacheWrite": 0, "total": 0.12 },
                },
                "stopReason": "tool_calls",
                "timestamp": 1_789_584_016_603_i64 + turn as i64,
            },
            "type": "message",
        }));
        rows.push(row);
        let row = entry(&mut counter, &mut parent, json!({
            "message": {
                "role": "toolResult",
                "toolCallId": call_id,
                "content": [{ "type": "text", "text": format!("corpus {turn}\n[0, 1, 2]\n") }],
                "isError": false,
                "timestamp": 1_789_584_016_603_i64 + turn as i64,
            },
            "type": "message",
        }));
        rows.push(row);
        if (turn + 1) % 20 == 0 {
            let row = entry(&mut counter, &mut parent, json!({
                "customType": "harness_digest",
                "content": format!(
                    "[harness-digest] note {turn}: persistent state summary for the corpus."
                ),
                "type": "custom_message",
            }));
            rows.push(row);
        }
    }
    let row = entry(&mut counter, &mut parent, json!({
        "message": {
            "role": "user",
            "content": [{ "type": "text", "text": "final marker request" }],
            "timestamp": 1_789_584_016_603_i64,
        },
        "type": "message",
    }));
    rows.push(row);
    let row = entry(&mut counter, &mut parent, json!({
        "message": {
            "role": "assistant",
            "content": [
                { "type": "thinking", "thinking": "final marker" },
                { "type": "text", "text": "CVIS-E2E-TAIL end of corpus." },
            ],
            "api": "openai-completions",
            "provider": "prime-inference",
            "model": "mock-1",
            "usage": {
                "input": 100, "output": 20, "cacheRead": 10, "cacheWrite": 0,
                "totalTokens": 130,
                "cost": { "input": 0.1, "output": 0.02, "cacheRead": 0, "cacheWrite": 0, "total": 0.12 },
            },
            "stopReason": "stop",
            "timestamp": 1_789_584_016_603_i64,
        },
        "type": "message",
    }));
    rows.push(row);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut text = String::new();
    for row in rows {
        text.push_str(&serde_json::to_string(&row).unwrap());
        text.push('\n');
    }
    std::fs::write(path, text).unwrap();
}

/// One timestamped RPC child for the compaction-visibility oracles: the
/// reader records each frame with the `Instant` its read chunk arrived,
/// so a frame's client-visibility time is the pipe-arrival time, not a
/// later poll (the same arrival-accurate rule the bench frame pump has).
struct TimedRpcChild {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    frames: Option<std::sync::mpsc::Receiver<(std::time::Instant, Value)>>,
    /// Held while the reader is deferred (the stalled-reader oracle).
    pending_stdout: Option<std::process::ChildStdout>,
    next_id: u64,
    home: tempfile::TempDir,
}

impl TimedRpcChild {
    fn spawn(fixture: &std::path::Path, script: &Value) -> TimedRpcChild {
        let mut child = Self::spawn_stalled(fixture, script);
        child.begin_reading();
        child
    }

    /// Spawn with the reader thread deferred: the stalled-reader oracle
    /// holds the child's stdout pipe unread (a full pipe blocks the
    /// writer task mid-write) until `begin_reading` starts the drain.
    fn spawn_stalled(fixture: &std::path::Path, script: &Value) -> TimedRpcChild {
        let home = tempfile::TempDir::new().unwrap();
        let bin = env!("CARGO_BIN_EXE_prime-agent");
        let mut child = Command::new(bin)
            .args(["--mode", "rpc", "--resume", fixture.to_str().unwrap()])
            .env("HOME", home.path())
            .env("PRIME_AGENT_FAUX_SCRIPT", script.to_string())
            .env("RUST_LOG", "error")
            .current_dir(home.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("binary present");
        let stdin = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");
        // The child's stderr must drain for the trial's lifetime: a
        // piped-but-undrained stderr fills its 64KB pipe and the child
        // blocks on its next log write, wedging the very path the test
        // measures.
        std::thread::spawn(move || {
            use std::io::Read;
            let mut sink = [0u8; 8192];
            let mut stderr = stderr;
            while matches!(stderr.read(&mut sink), Ok(n) if n > 0) {}
        });
        TimedRpcChild {
            child,
            stdin,
            frames: None,
            pending_stdout: Some(stdout),
            next_id: 0,
            home,
        }
    }

    /// Start the deferred reader thread (the stalled-reader oracle holds
    /// it back until the stall window closes).
    fn begin_reading(&mut self) {
        let (tx, frames) = std::sync::mpsc::channel();
        let stdout = self.pending_stdout.take().expect("reader started once");
        std::thread::spawn(move || {
            use std::io::Read;
            let mut stdout = stdout;
            let mut buf: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 65536];
            loop {
                match stdout.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let arrived = Instant::now();
                        buf.extend_from_slice(&chunk[..n]);
                        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                            let line: Vec<u8> = buf.drain(..=pos).collect();
                            let line = String::from_utf8_lossy(&line).trim().to_owned();
                            if line.is_empty() {
                                continue;
                            }
                            let frame: Value =
                                serde_json::from_str(&line).expect("valid JSON line");
                            if tx.send((arrived, frame)).is_err() {
                                return;
                            }
                        }
                    }
                }
            }
        });
        self.frames = Some(frames);
    }

    fn send(&mut self, frame: Value) {
        let mut line = serde_json::to_string(&frame).unwrap();
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).unwrap();
        self.stdin.flush().unwrap();
    }

    fn command(&mut self, command: &Value) -> (String, Instant) {
        self.next_id += 1;
        let id = format!("t-{}", self.next_id);
        let mut frame = command.clone();
        frame["id"] = json!(id);
        let sent = Instant::now();
        self.send(frame);
        (id, sent)
    }

    /// Read frames until `id`'s response, returning the events seen
    /// before it, each with its arrival instant.
    fn wait_response(&mut self, id: &str, timeout: Duration) -> (Value, Vec<(Instant, Value)>) {
        let deadline = Instant::now() + timeout;
        let mut events = Vec::new();
        let frames = self.frames.as_ref().expect("reader started");
        loop {
            let timeout_left = deadline.saturating_duration_since(Instant::now());
            assert!(!timeout_left.is_zero(), "timed out waiting for {id}");
            match frames.recv_timeout(timeout_left) {
                Ok((arrived, frame)) => {
                    if frame.get("type").and_then(Value::as_str) == Some("response")
                        && frame.get("id").and_then(Value::as_str) == Some(id)
                    {
                        return (frame, events);
                    }
                    events.push((arrived, frame));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    panic!("timed out waiting for response {id} (events: {events:?})")
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    panic!("rpc child closed before {id} answered (events: {events:?})")
                }
            }
        }
    }
}

impl Drop for TimedRpcChild {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The compaction's `compaction_start` frame reaches the client BEFORE
/// the compaction pipeline runs (the served-path oracle): the handler
/// flushes the queued frame before entering the pre-summarizer CPU span
/// (digest capture, cut scan, token estimation, details extraction) —
/// a span that runs to the summarizer's `await` without an executor
/// yield, so without the flush the queued frame strands behind it and
/// the client sees the compaction start only when the span ends. TS
/// writes stdout frames synchronously at the emit, so the flush is the
/// TS-parity shape, and the oracle bites from both sides: the start must
/// arrive inside the flush budget, and the pipeline after it must be a
/// span an unflushed frame would have straggled behind.
#[test]
fn rpc_compact_flushes_the_start_frame_before_the_pipeline() {
    let home = tempfile::TempDir::new().unwrap();
    let fixture = home.path().join("sess").join("fixture.jsonl");
    write_corpus_fixture(&fixture, 10);
    let script = json!({
        // The faux harness's response budget is finite (repeat-last is a
        // daemon-seam key the CLI harness ignores): the split-turn cut
        // makes two concurrent summarizer calls, so the script queues
        // one response each.
        "responses": [
            { "text": "corpus history summary: the scale corpus ran" },
            { "text": "corpus turn-prefix summary: the final marker" },
        ],
    });
    let mut client = TimedRpcChild::spawn(&fixture, &script);
    let (ready, _) = client.command(&json!({ "type": "get_state" }));
    let (_, _) = client.wait_response(&ready, TIMEOUT);
    let (id, sent) = client.command(&json!({ "type": "compact" }));
    let (response, events) = client.wait_response(&id, TIMEOUT);
    assert_eq!(response["success"], true, "the response: {response}");
    let result = &response["data"];
    let summary = result["summary"].as_str().expect("the summary");
    assert!(
        summary.contains("corpus history summary: the scale corpus ran")
            && summary.contains("corpus turn-prefix summary: the final marker"),
        "the split-turn compaction composes both summarizer answers: {summary}"
    );
    assert!(
        result["tokensBefore"].is_number(),
        "the CompactionResult shape"
    );
    let mut cs: Option<(Instant, &Value)> = None;
    let mut ce: Option<(Instant, &Value)> = None;
    for (arrived, event) in &events {
        match event.get("type").and_then(Value::as_str) {
            Some("compaction_start") if cs.is_none() => cs = Some((*arrived, event)),
            Some("compaction_end") if ce.is_none() => ce = Some((*arrived, event)),
            _ => {}
        }
    }
    let (cs_at, cs_event) = cs.expect("the compaction_start event");
    let (ce_at, _) = ce.expect("the compaction_end event");
    assert_eq!(cs_event["reason"], "requested");
    assert!(
        cs_event.get("result").is_none(),
        "compaction_start carries no result (TS shape)"
    );
    let cs_ms = cs_at.duration_since(sent).as_secs_f64() * 1000.0;
    let start_to_end_ms = ce_at.duration_since(cs_at).as_secs_f64() * 1000.0;
    // The flush: the start frame is visible to the client immediately
    // (a pipe write, microseconds) — well before the pre-summarizer span
    // (tens of milliseconds at this session size) could strand it.
    assert!(
        cs_ms < 20.0,
        "compaction_start arrived {cs_ms:.1}ms after the command: \
         the queued frame stranded behind the pre-summarizer span"
    );
    // Anti-vacuity: the span after the start frame is exactly the
    // stranding window — a session too small to strand a frame would
    // make the assert above vacuous.
    assert!(
        start_to_end_ms > 20.0,
        "the compaction span after the start frame was only \
         {start_to_end_ms:.1}ms: the fixture is too small to strand a frame"
    );
}

/// The flush is bounded against a stalled reader: with the client's
/// pipe full (an unread multi-MiB `get_state` response) the writer task
/// blocks mid-write, and the compaction must still complete — the
/// budget expires, the command proceeds, and every frame flows once the
/// reader drains. An unbounded drain would wedge the compaction behind
/// the reader forever (TS never blocks a command on the reader).
#[test]
fn rpc_compact_flush_is_bounded_against_a_stalled_reader() {
    let home = tempfile::TempDir::new().unwrap();
    let fixture = home.path().join("sess").join("fixture.jsonl");
    write_corpus_fixture(&fixture, 10);
    let script = json!({
        // The faux harness's response budget is finite (repeat-last is a
        // daemon-seam key the CLI harness ignores): the split-turn cut
        // makes two concurrent summarizer calls, so the script queues
        // one response each.
        "responses": [
            { "text": "corpus history summary: the scale corpus ran" },
            { "text": "corpus turn-prefix summary: the final marker" },
        ],
    });
    let mut client = TimedRpcChild::spawn_stalled(&fixture, &script);
    // No reader thread touches stdout: the get_messages response (the
    // session's whole serialized context, well over the pipe capacity)
    // fills the pipe and the writer task blocks mid-write — `pending`
    // stays nonzero through the compaction, so its start-frame flush can
    // only retire by hitting the budget.
    let (messages, _) = client.command(&json!({ "type": "get_messages" }));
    let (id, _) = client.command(&json!({ "type": "compact" }));
    std::thread::sleep(Duration::from_millis(500));
    // The compaction ran BEHIND the stalled pipe: the budget expired
    // (50ms) instead of waiting the reader out, so the durable
    // compaction row is already in the session file. An unbounded drain
    // would still be spinning in its wait loop — no row, and the test
    // fails right here.
    // The compaction runs BEHIND the stalled pipe: the budget expired
    // (50ms) instead of waiting the reader out, so the durable
    // compaction row lands in the session file while no reader drains
    // the child. An unbounded drain would still be spinning in its wait
    // loop — no row ever lands while the reader is stalled, and the
    // poll deadline fails right here. (The row's landing time varies
    // with the pipe-stall CPU contention, hence the poll instead of a
    // fixed sleep.)
    let row_deadline = Instant::now() + Duration::from_secs(4);
    let mut compacted_behind_the_stall = false;
    while Instant::now() < row_deadline {
        let session = std::fs::read_to_string(&fixture).expect("session file");
        if session
            .lines()
            .any(|line| line.contains("\"type\":\"compaction\""))
        {
            compacted_behind_the_stall = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        compacted_behind_the_stall,
        "the compaction never ran behind the stalled reader: the flush \
         wedged the command on the reader"
    );
    // The stall drains now: every held frame flows, the compact's
    // response is among them, and the child never wedged.
    let _ = messages;
    client.begin_reading();
    let (response, _) = client.wait_response(&id, TIMEOUT);
    assert_eq!(response["success"], true, "the response: {response}");
}
