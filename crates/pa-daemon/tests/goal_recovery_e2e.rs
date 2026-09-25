//! End-to-end verifier for durable `thread_goal_state` persistence (the
//! #238 durability gap): the worker session file must carry the
//! `thread_goal_state` custom rows a started goal writes (TS
//! `_persistGoalState`: one store with the transcript), and a worker
//! killed mid-goal must rebuild with the goal rehydrated — the objective,
//! usage counters, and the continuation count continuing from the durable
//! rows, not from a fresh engine.
//!
//! The flow (the f21 worker-recovery pattern): a faux-scripted session
//! over the real agent engine starts a goal, runs work turns, compacts
//! (the post-compaction mint bumps `continuationsUsed` durably), is
//! SIGKILLed, and recovers through the supervisor's respawn — then keeps
//! using the goal, with the second compact's mint continuing the count.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const GOAL_STATE_CUSTOM_TYPE: &str = "thread_goal_state";
const OBJECTIVE: &str = "ship the goal-recovery port";

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
                    if Instant::now() - last_line >= quiet_ms {
                        return;
                    }
                }
            }
        }
    }
}

/// The harness: a supervisor, a faux-scripted session over the real agent
/// engine (compaction enabled with a tiny keep window so a manual compact
/// cuts), and the session file the durable rows land in.
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
    std::fs::create_dir_all(&session_dir).expect("session dir");
    // A tiny keep window: the manual compact always has a cut to make, so
    // the post-compaction goal-continue branch runs (the mint that bumps
    // `continuationsUsed` durably).
    std::fs::write(
        agent_dir.join("settings.json"),
        json!({
            "compaction": { "enabled": true, "keepRecentTokens": 10, "reserveTokens": 100 }
        })
        .to_string(),
    )
    .expect("write settings");
    let responses: Vec<Value> = (0..16)
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
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["activeSessionId"]
        .as_str()
        .or_else(|| created["data"]["id"].as_str())
        .expect("active session id")
        .to_string();
    // Session events only reach attached wire clients; attach so the
    // goal_update announcements are observable.
    client.send_command(
        "a1",
        json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let attached = client.request("a1");
    assert_eq!(attached["success"], true, "attach failed: {attached}");
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

    /// The session file's `thread_goal_state` custom rows, in file order.
    fn goal_state_rows(&self) -> Vec<Value> {
        std::fs::read_to_string(self.session_file())
            .expect("session file readable")
            .lines()
            .filter(|line| !line.trim().is_empty())
            .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
            .filter(|entry| {
                entry.get("type").and_then(Value::as_str) == Some("custom")
                    && entry.get("customType").and_then(Value::as_str)
                        == Some(GOAL_STATE_CUSTOM_TYPE)
            })
            .collect()
    }

    /// The latest goal state re-read from the durable file.
    fn latest_goal_row(&self) -> Value {
        self.goal_state_rows()
            .last()
            .cloned()
            .unwrap_or(Value::Null)["data"]
            .clone()
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
        assert_eq!(done["success"], true, "prompt {id} failed: {done}");
        self.client.drain_events(Duration::from_secs(1));
    }

    /// The f18-battery prompt form: send and wait for the response without
    /// the quiet drain. The goal-continuation loop keeps the session
    /// churning (the socket never goes quiet while it runs), so a prompt
    /// racing the loop (the pause right after a phase that starts turns)
    /// must not settle first — the drain would block for the whole churn.
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
        assert_eq!(done["success"], true, "prompt {id} failed: {done}");
    }

    /// The last goal_update announcement's `continuationsUsed`.
    fn announced_continuations(&self) -> Vec<u64> {
        self.client
            .events
            .iter()
            .filter(|event| event.get("type").and_then(Value::as_str) == Some("goal_update"))
            .filter_map(|event| event["goal"]["continuationsUsed"].as_u64())
            .collect()
    }
}

/// The mid-goal worker kill + recovery: the goal must survive the rebuild
/// with its durable counts, and a post-recovery compact continues the
/// continuation count from where the durable rows left it.
///
/// The goal-continuation loop (TS `_getGoalContinuationMessages`) keeps
/// prompting an active goal at every natural turn end, so like the f18
/// battery the flow pauses the goal right after each phase that starts
/// turns: the pause (TS `_pauseGoal` -> `_clearQueuedGoalContexts`)
/// withdraws the minted continuation waiting in the queue, and everything
/// between the phases runs against a quiet (paused) goal driver.
#[test]
fn killed_mid_goal_worker_rehydrates_the_goal_with_counts() {
    let mut harness = setup("goal-recovery");

    // A started goal persists: the session file carries the
    // `thread_goal_state` custom row (TS one-store durability). The start
    // turn's natural end mints the goal loop's next continuation (the
    // ported hook), so the durable count is at least 1 by the time the
    // prompt settles.
    harness.prompt_racing_the_loop("g1", &format!("/goal {OBJECTIVE}"));
    // Pause immediately (the f18 battery pattern): the purge withdraws the
    // queued continuation and the loop goes quiet; everything else runs
    // against the paused driver.
    harness.prompt_racing_the_loop("g2", "/goal pause");
    harness.client.drain_events(Duration::from_secs(1));
    let goal = harness.latest_goal_row();
    assert_eq!(goal["status"], "paused", "durable goal row: {goal}");
    assert_eq!(goal["objective"], OBJECTIVE);
    let pre_seed_count = goal["continuationsUsed"].as_u64().unwrap();
    assert!(
        pre_seed_count >= 1,
        "the start turn never minted a continuation: {goal}"
    );

    // Seed work turns so the manual compact has a cut to make (the goal
    // is paused: no turn mints a continuation).
    harness.prompt("s1", "first work turn for the cut");
    harness.prompt("s2", "second work turn for the cut");
    let goal = harness.latest_goal_row();
    assert_eq!(
        goal["continuationsUsed"].as_u64().unwrap(),
        pre_seed_count,
        "a paused goal consumed continuation slots: {goal}"
    );

    // Resume, then pause again before the loop churns: the resumed driver
    // runs its continuation turn and the pause keeps the queue quiet.
    harness.prompt_racing_the_loop("r0", "/goal resume");
    harness.prompt_racing_the_loop("r0p", "/goal pause");
    harness.client.drain_events(Duration::from_secs(1));
    let goal = harness.latest_goal_row();
    assert_eq!(goal["status"], "paused", "durable goal row: {goal}");
    let pre_compact_count = goal["continuationsUsed"].as_u64().unwrap();
    assert!(
        pre_compact_count > pre_seed_count,
        "the resume never minted: {goal}"
    );

    // The compact mints the owed continuation on the reactivated goal:
    // resume for the compact, compact, then pause again — the count the
    // compact minted (and everything after) is durable.
    harness.prompt_racing_the_loop("r1", "/goal resume");
    harness.client.send_command(
        "c2",
        json!({ "type": "compact", "activeSessionId": harness.session_id }),
    );
    let compact = harness.client.request("c2");
    assert_eq!(compact["success"], true, "compact failed: {compact}");
    harness.prompt_racing_the_loop("p3", "/goal pause");
    harness.client.drain_events(Duration::from_secs(1));
    harness.client.send_command(
        "w2",
        json!({ "type": "wait_for_idle", "activeSessionId": harness.session_id }),
    );
    let idle = harness.client.request("w2");
    assert_eq!(idle["success"], true, "never went idle: {idle}");
    harness.client.drain_events(Duration::from_secs(1));
    assert!(
        harness
            .announced_continuations()
            .iter()
            .any(|count| *count > pre_compact_count),
        "the compact mint never announced a higher count: {:?}",
        harness.client.events
    );
    let goal = harness.latest_goal_row();
    let pre_kill_count = goal["continuationsUsed"].as_u64().unwrap();
    assert!(
        pre_kill_count > pre_compact_count,
        "the compact never minted a durable continuation: {goal}"
    );
    assert_eq!(goal["status"], "paused", "durable goal row: {goal}");

    // The daemon's own session summary names the live worker pid.
    harness.client.send_command(
        "st1",
        json!({ "type": "get_state", "activeSessionId": harness.session_id }),
    );
    let state = harness.client.request("st1");
    assert_eq!(state["success"], true, "get_state failed: {state}");
    let worker_pid = state["data"]["workerPid"].as_u64().expect("worker pid");
    let pre_kill_rows = harness.goal_state_rows().len();
    let pre_kill_events = harness.client.events.len();

    // Kill the worker mid-goal.
    let _ = std::process::Command::new("kill")
        .args(["-9", &worker_pid.to_string()])
        .status();
    std::thread::sleep(Duration::from_secs(3));

    // The supervisor respawns the worker; the recovered prompt completes.
    // Early attempts may race the respawn backoff, so the prompt retries
    // until the new worker serves it. The goal was paused before the
    // kill, so the recovery runs against a quiet driver.
    let deadline = Instant::now() + Duration::from_mins(3);
    let recovered = loop {
        assert!(Instant::now() < deadline, "the session never recovered");
        harness.client.send_command(
            "rp",
            json!({
                "type": "prompt_and_wait",
                "activeSessionId": harness.session_id,
                "message": "keep working after the crash",
            }),
        );
        let done = harness.client.request("rp");
        if done["success"] == true {
            break done;
        }
        std::thread::sleep(Duration::from_millis(500));
    };
    assert_eq!(
        recovered["success"], true,
        "recovery prompt failed: {recovered}"
    );
    harness.client.drain_events(Duration::from_secs(1));

    // The rebuilt worker answers with the rehydrated goal: the objective
    // and the durable continuation count, not a fresh engine's empty
    // state. The recovery turn's usage accounting announces from the
    // rehydrated base (TS `_accountGoalUsageForAssistantMessage` ->
    // `_emitGoalUpdate`): the rehydrated count never resets.
    harness.client.send_command(
        "st2",
        json!({
            "type": "get_connection_state",
            "activeSessionId": harness.session_id,
        }),
    );
    let connection = harness.client.request("st2");
    assert_eq!(
        connection["success"], true,
        "get_connection_state failed: {connection}"
    );
    let goal = &connection["data"]["goal"];
    assert_eq!(
        goal["status"], "paused",
        "connection state goal: {connection}"
    );
    assert_eq!(goal["objective"], OBJECTIVE);
    assert_eq!(
        goal["continuationsUsed"].as_u64().unwrap(),
        pre_kill_count,
        "connection state goal: {connection}"
    );
    let recovery_announcements: Vec<u64> = harness.client.events[pre_kill_events..]
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("goal_update"))
        .filter_map(|event| event["goal"]["continuationsUsed"].as_u64())
        .collect();
    assert!(
        recovery_announcements
            .iter()
            .all(|count| *count >= pre_kill_count),
        "a post-recovery announcement reset the count: {recovery_announcements:?}"
    );

    // The rebuilt session keeps using the goal: a resumed turn's usage
    // accounting continues from the rehydrated base — the durable rows
    // keep growing with the objective and count intact (the rehydrated
    // mint's count continuation is pinned by the
    // `recovery_rebuild_rehydrates_the_goal_from_the_session_file` unit).
    harness.prompt_racing_the_loop("rr", "/goal resume");
    harness.prompt_racing_the_loop("rrp", "/goal pause");
    harness.client.drain_events(Duration::from_secs(1));
    // The recovery mirrored the post-recovery accounting rows durably: the
    // file's goal rows only grew.
    assert!(
        harness.goal_state_rows().len() > pre_kill_rows,
        "the recovery wrote no new durable goal rows"
    );
    let goal = harness.latest_goal_row();
    assert!(
        goal["continuationsUsed"].as_u64().unwrap() >= pre_kill_count,
        "a post-recovery turn reset the durable count: {goal}"
    );
    assert_eq!(goal["status"], "paused", "durable goal row: {goal}");
    assert_eq!(goal["objective"], OBJECTIVE);
    assert!(
        goal["tokensUsed"].as_u64().unwrap() > 0,
        "usage accounting never continued: {goal}"
    );

    // The post-recovery compact runs over the durable history (TS
    // one-store recovery, #243): the respawned session's branch is
    // rebuilt from the store, so the compaction walk sees the pre-crash
    // conversation — never the fresh engine's empty branch that skips
    // "Session is too short to compact". The pause-gated union keeps the
    // loop quiet around it: resume for the compact (an active goal's
    // compact mints the owed continuation), compact, pause again, then
    // let the session settle.
    let pre_final_count = harness.latest_goal_row()["continuationsUsed"]
        .as_u64()
        .unwrap();
    harness.prompt_racing_the_loop("rf", "/goal resume");
    harness.client.send_command(
        "c3",
        json!({ "type": "compact", "activeSessionId": harness.session_id }),
    );
    let compact = harness.client.request("c3");
    assert_eq!(
        compact["success"], true,
        "the post-recovery compact skipped on an empty branch: {compact}"
    );
    harness.prompt_racing_the_loop("rfp", "/goal pause");
    harness.client.send_command(
        "w3",
        json!({ "type": "wait_for_idle", "activeSessionId": harness.session_id }),
    );
    let idle = harness.client.request("w3");
    assert_eq!(idle["success"], true, "never went idle: {idle}");
    harness.client.drain_events(Duration::from_secs(1));

    // The compaction walk saw the durable history: the durable file holds
    // a second compaction entry, and the compact minted the owed
    // continuation off the rehydrated goal (the count grew past the
    // pre-compact value, durable and announced).
    let compaction_rows = std::fs::read_to_string(harness.session_file())
        .expect("session file readable")
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter(|line| line.contains("\"type\":\"compaction\""))
        .count();
    assert!(
        compaction_rows >= 2,
        "the post-recovery compact never persisted a second compaction entry"
    );
    let goal = harness.latest_goal_row();
    let post_final_count = goal["continuationsUsed"].as_u64().unwrap();
    assert!(
        post_final_count > pre_final_count,
        "the post-recovery compact never minted off the rehydrated count: {goal}"
    );
    assert_eq!(goal["status"], "paused", "durable goal row: {goal}");
    assert_eq!(goal["objective"], OBJECTIVE);
    assert!(
        harness
            .announced_continuations()
            .contains(&post_final_count),
        "the post-recovery mint never announced continuationsUsed {post_final_count}: {:?}",
        harness.client.events
    );
}
