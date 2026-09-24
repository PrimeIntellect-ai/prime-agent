//! RLM child admission vs worker replacement: concurrent spawns stay
//! admitted and every child's task prompt lands exactly once even when a
//! child's worker process is killed between its admission and the prompt.
//!
//! The regression (the lane's forensics: 69/172 spawned children never
//! received their prompt): the admission path re-read the child's session
//! file from a second racy `get_state`, so a worker replacement racing the
//! admission tore down healthy children; and the detached task prompt fired
//! into a worker mid-replacement (crash backoff, relaunch, create replay)
//! where the route hit a dead socket - the prompt was lost and the
//! relaunched child was killed by the prompt task's error path.
//!
//! The fixed invariants this verifier pins:
//!
//! 1. Concurrent spawns all admit: every `rlm.spawn` returns a handle even
//!    while another worker is being replaced (admission reads the create
//!    response, never a second `get_state`).
//! 2. A child whose worker is replaced between admission and its task
//!    prompt still receives the prompt EXACTLY ONCE: the replacement-aware
//!    route waits out the replacement (the create replay restores the same
//!    session file), so the prompt neither bounces off the dead socket nor
//!    duplicates onto the relaunched worker.
//! 3. No admission teardown of a healthy child: the replaced child is
//!    relaunched with the same worker id, its session file is not archived,
//!    and it settles with its answer.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use pa_core::session_engine::rlm_host::{RlmSpawnRequest, RlmSubagentHost};
use pa_daemon::rlm_children::{ParentIdentity, SupervisorChildSessions};
use pa_daemon::supervisor_link::SupervisorLink;
use serde_json::{json, Value};

struct Daemon {
    child: Child,
    #[allow(dead_code)]
    socket: PathBuf,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// The timeout panic path cannot wait on the child; the test process exits
// immediately afterwards, reaping it.
#[allow(clippy::zombie_processes)]
fn spawn_daemon(socket: &Path, agent_dir: &Path) -> Daemon {
    let binary = env!("CARGO_BIN_EXE_pa-daemon");
    let child = Command::new(binary)
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .stdout(Stdio::null())
        // The supervisor's debug stream lands next to the agent dir so a
        // failing wait can print the routing story.
        .stderr(Stdio::from(
            std::fs::File::create(agent_dir.join("supervisor.stderr")).expect("stderr file"),
        ))
        .env("PA_DAEMON_DEBUG", "1")
        // A supervisor killed at teardown must not leak its session workers
        // into later test binaries: the worker's supervisor-lost exit (TS
        // `exitIfSupervisorOrphanedForTooLong`) runs on this short window
        // instead of the 5-minute default.
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
        // The worker-connect budget (probe + connect + auth) must survive
        // a battery-loaded box: this test launches four workers while the
        // whole workspace runs around them, and a 30s budget failed
        // starved boots in full gates (the flake this suite pins). The
        // override stays under the spawn admission's 120s link budget.
        .env("PA_DAEMON_WORKER_CONNECT_TIMEOUT_MS", "90000")
        .spawn()
        .expect("spawn pa-daemon supervisor");
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        if UnixStream::connect(socket).is_ok() {
            return Daemon {
                child,
                socket: socket.to_path_buf(),
            };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("supervisor socket never came up");
}

/// Minimal JSONL supervisor client (list).
struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Client {
    fn connect(socket: &Path) -> (Self, Value) {
        let deadline = Instant::now() + Duration::from_secs(5);
        let stream = loop {
            match UnixStream::connect(socket) {
                Ok(stream) => break stream,
                Err(_) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => panic!("connect supervisor: {error}"),
            }
        };
        let write_stream = stream.try_clone().expect("clone socket");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer: write_stream,
        };
        let hello = client.read_line();
        (client, hello)
    }

    fn send_command(&mut self, id: &str, command: Value) {
        let envelope = json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        });
        let mut line = serde_json::to_string(&envelope).expect("serialize command");
        line.push('\n');
        self.writer.write_all(line.as_bytes()).expect("send");
        self.writer.flush().expect("flush");
    }

    fn read_line(&mut self) -> Value {
        let mut line = String::new();
        // Generous: on a battery-loaded box the supervisor process
        // competes for CPU with the whole workspace run, and a line can
        // lag far past an interactive box's latency.
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
                Ok(_) => return serde_json::from_str(line.trim()).expect("parse response line"),
                Err(error) => {
                    assert!(
                        Instant::now() < deadline,
                        "timed out waiting for supervisor line: {error}"
                    );
                }
            }
        }
    }

    fn read_response(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }
}

/// The supervisor roster's session summaries (the `list` wire surface).
fn roster_summaries(client: &mut Client, id: &str) -> Vec<Value> {
    client.send_command(id, json!({ "type": "list" }));
    let list = client.read_response(id);
    assert_eq!(list["success"], true, "list failed: {list}");
    list["data"]["sessions"]
        .as_array()
        .cloned()
        .expect("sessions array")
}

/// Poll a sync probe (JSONL supervisor client) until it yields a value.
fn wait_until<T>(budget: Duration, context: &str, mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + budget;
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "condition never became true: {context}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The child's scripted engine: one immediate response per child session.
fn write_script(dir: &Path, answer: &str) -> PathBuf {
    let script = dir.join("script.json");
    std::fs::write(
        &script,
        json!({ "responses": [ { "text": answer, "delayMs": 30 } ] }).to_string(),
    )
    .expect("write script");
    script
}

/// Children registry bound to the running supervisor, with a parent identity
/// rooted at `agent_dir`.
async fn children(socket: &Path, agent_dir: &Path, script: &Path) -> SupervisorChildSessions {
    let sessions = SupervisorChildSessions::new(
        Arc::new(SupervisorLink::new(socket.to_path_buf())),
        agent_dir.to_path_buf(),
        "parent-active-id".to_string(),
        std::sync::Arc::new(pa_daemon::model_allowlist::ModelRefusalTelemetry::new(
            agent_dir.to_path_buf(),
            /*telemetry_disabled*/ true,
        )),
    );
    sessions.set_identity(ParentIdentity {
        rlm_depth: 0,
        rlm_max_depth: 2,
        // Off-catalog on purpose: scripted children do not resolve models.
        model: Some("scripted/faux-1".to_string()),
        cwd: Some(agent_dir.to_string_lossy().to_string()),
        session_id: Some("parent-session-uuid".to_string()),
        session_file: Some(agent_dir.join("parent.jsonl").to_string_lossy().to_string()),
        thinking: None,
        child_script: Some(script.to_string_lossy().to_string()),
    });
    sessions
}

fn spawn_request(name: &str, prompt: &str) -> RlmSpawnRequest {
    RlmSpawnRequest {
        prompt: prompt.to_string(),
        name: Some(name.to_string()),
        model: None,
        thinking: None,
        cell_source_code: None,
    }
}

/// The child's persisted session file (the per-child artifacts dir holds
/// exactly one `.jsonl`).
fn child_session_file(agent_dir: &Path, child_id: &str) -> PathBuf {
    let dir = agent_dir
        .join("session-artifacts")
        .join("parent-session-uuid")
        .join(child_id);
    wait_until(
        Duration::from_secs(60),
        &format!("session file for {child_id}"),
        || {
            std::fs::read_dir(&dir)
                .ok()?
                .filter_map(std::result::Result::ok)
                .map(|entry| entry.path())
                .find(|path| {
                    path.extension().and_then(|extension| extension.to_str()) == Some("jsonl")
                })
        },
    )
}

/// One child's worker pid, from its supervisor descriptor (the live process
/// behind the roster row).
fn worker_pid(agent_dir: &Path, socket: &Path, worker_id: &str) -> u32 {
    let descriptor_dir = pa_daemon::descriptor::descriptor_dir(agent_dir, socket);
    let path = descriptor_dir.join(format!("{worker_id}.json"));
    let content = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read worker descriptor {}: {error}", path.display()));
    let descriptor: Value = serde_json::from_str(&content).expect("parse worker descriptor");
    descriptor["pid"]
        .as_u64()
        .filter(|pid| *pid != 0)
        .expect("worker descriptor pid") as u32
}

/// Concurrent spawns + a mid-window worker replacement: every child's task
/// prompt lands exactly once and no admitted child is torn down.
// Multi-thread runtime: the detached task prompts (`tokio::spawn` inside
// `SupervisorChildSessions`) must progress while the test thread blocks in
// its synchronous JSONL/file polls.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_spawns_prompt_exactly_once_across_a_worker_replacement() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");
    let script = write_script(dir.path(), "replacement kid answer");
    let children = children(&socket, &agent_dir, &script).await;

    // Four concurrent spawns, each with a unique prompt marker.
    let (a, b, c, d) = tokio::join!(
        children.spawn(spawn_request(
            "kid-a",
            "ship the marker-replacement-e2e-a task"
        )),
        children.spawn(spawn_request(
            "kid-b",
            "ship the marker-replacement-e2e-b task"
        )),
        children.spawn(spawn_request(
            "kid-c",
            "ship the marker-replacement-e2e-c task"
        )),
        children.spawn(spawn_request(
            "kid-d",
            "ship the marker-replacement-e2e-d task"
        )),
    );
    let handles = [a, b, c, d];
    let names = ["kid-a", "kid-b", "kid-c", "kid-d"];
    let child_ids: Vec<String> = handles
        .iter()
        .map(|handle| handle.as_ref().expect("spawn").rlm_child_id.clone())
        .collect();
    for (handle, name) in handles.iter().zip(names.iter()) {
        let handle = handle.as_ref().expect("spawn");
        assert!(handle.rlm_child_id.starts_with("sub-"), "{handle:?}");
        assert_eq!(handle.name, *name);
    }

    // The supervisor roster carries all four resident children.
    for name in names {
        wait_until(
            Duration::from_secs(120),
            &format!("roster row for {name}"),
            || {
                roster_summaries(&mut client, "l0")
                    .into_iter()
                    .find(|summary| {
                        summary["sessionName"] == json!(name)
                            && summary["runtimeKind"] == "subagent"
                    })
            },
        );
    }

    // The replacement: kill kid-a's worker between its admission and its
    // task prompt (the detached prompt fires at the parent's turn
    // boundary, released below). The supervisor restarts the worker
    // (backoff + relaunch + create replay) while the prompt is in flight.
    let kid_a_worker_id = {
        let row = wait_until(Duration::from_secs(60), "kid-a roster row", || {
            roster_summaries(&mut client, "l1")
                .into_iter()
                .find(|summary| summary["sessionName"] == json!("kid-a"))
        });
        row["activeSessionId"]
            .as_str()
            .expect("kid-a worker id")
            .to_string()
    };
    let kid_a_pid = worker_pid(&agent_dir, &socket, &kid_a_worker_id);
    let killed = Command::new("kill")
        .arg("-9")
        .arg(kid_a_pid.to_string())
        .status()
        .expect("kill kid-a worker");
    assert!(killed.success(), "kill -9 {kid_a_pid}");

    // Release the detached task prompts (the parent's turn boundary): all
    // four fire now - kid-a's into a worker mid-replacement.
    children.notify_turn_done();

    // Exactly-once: each child's session file carries its prompt marker
    // exactly once. kid-a's prompt must survive the replacement (the
    // budget covers the replacement window end to end).
    for (child_id, name) in child_ids.iter().zip(names.iter()) {
        let marker = format!("marker-replacement-e2e-{}", name.trim_start_matches("kid-"));
        let session_file = child_session_file(&agent_dir, child_id);
        let deadline = Instant::now() + Duration::from_secs(150);
        let content = loop {
            let content = std::fs::read_to_string(&session_file).unwrap_or_default();
            if content.matches(&marker).count() == 1 {
                break content;
            }
            if Instant::now() >= deadline {
                let stderr = std::fs::read_to_string(agent_dir.join("supervisor.stderr"))
                    .unwrap_or_default();
                let tail: Vec<&str> = stderr.lines().rev().take(80).collect();
                let artifacts: Vec<PathBuf> = std::fs::read_dir(session_file.parent().unwrap())
                    .map(|entries| {
                        entries
                            .filter_map(std::result::Result::ok)
                            .map(|e| e.path())
                            .collect()
                    })
                    .unwrap_or_default();
                panic!(
                    "marker {marker} never landed for {name}\nsession file {session_file:?}: {content}\nartifacts dir: {artifacts:?}\nroster: {:?}\nsupervisor stderr tail (reversed): {tail:#?}",
                    roster_summaries(&mut client, "dump")
                );
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        assert!(
            !content.contains("archived"),
            "no admitted child is torn down by the replacement: {content}"
        );
    }

    // The replaced child is alive again - the same worker id, relaunched,
    // not archived - and every child settles with its answer.
    {
        let row = wait_until(
            Duration::from_secs(150),
            "kid-a relaunched roster row",
            || {
                roster_summaries(&mut client, "l2")
                    .into_iter()
                    .find(|summary| summary["activeSessionId"] == json!(kid_a_worker_id))
            },
        );
        assert_eq!(row["sessionName"], "kid-a");
        assert_ne!(
            row["archived"],
            json!(true),
            "relaunched child archived: {row}"
        );
    }
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        let entries = children.list_subagents().await.expect("list subagents");
        let settled = entries
            .iter()
            .filter(|entry| entry.answer_preview.as_deref() == Some("replacement kid answer"))
            .count();
        assert!(
            Instant::now() < deadline,
            "children never settled: {entries:?}"
        );
        if settled == 4 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
