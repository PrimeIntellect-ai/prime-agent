//! The fork-isolation verifier (operator bug #5): a session forked with
//! `/fork` must be a FULLY detached session. The worker replaces its live
//! session file in place (a new durable id and file under the same worker
//! address), and every supervisor-side route must follow that move: a
//! message targeted at the ORIGINAL session file reaches the original
//! (its own worker), never the fork; the fork's own sends flow to the
//! fork; and the roster keeps both sessions visible, each owned by the
//! worker that serves it.
//!
//! The pin battery: (a) the isolation pin — a create over the original
//! file after the fork opens the ORIGINAL (a fresh worker over the
//! file), and its prompt never lands in the fork's transcript; (b) the
//! reverse pin — the fork's own prompt never lands in the original's
//! transcript; (c) the independence pin — the fork's client keeps
//! serving its own turns; (d) the visibility pin — the roster carries
//! both sessions, and the fork's swap retires the stale row that still
//! presented the original as the fork worker's live root; plus the
//! stale-binding pin — after the fork's worker dies, the fork's old
//! address does not rebind into the original's worker.
// Pedantic-gate dispositions (fleet-uniform ruling; see this lane's PR
// for the full rationale).
#![allow(clippy::large_futures)]
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
#![allow(clippy::too_many_lines)]
#![allow(
    clippy::unnecessary_wraps,
    clippy::zero_sized_map_values,
    clippy::struct_excessive_bools,
    clippy::struct_field_names
)]
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

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
fn spawn_daemon(socket: &std::path::Path, agent_dir: &std::path::Path) -> Daemon {
    let binary = env!("CARGO_BIN_EXE_pa-daemon");
    let child = Command::new(binary)
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
        .spawn()
        .expect("spawn pa-daemon supervisor");
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if socket.exists() {
            return Daemon {
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
}

impl Client {
    fn connect(socket: &std::path::Path) -> Self {
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
        assert_eq!(hello["type"], "daemon_hello");
        client
    }

    fn send_command(&mut self, id: &str, command: &serde_json::Value) {
        let mut line = serde_json::to_string(&serde_json::json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        }))
        .expect("serialize command");
        line.push('\n');
        self.writer.write_all(line.as_bytes()).expect("send");
        self.writer.flush().expect("flush");
    }

    fn read_line(&mut self) -> serde_json::Value {
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_secs(20);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => {}
                Ok(_) => {
                    return serde_json::from_str(line.trim()).expect("parse response line");
                }
                Err(error) => {
                    assert!(
                        Instant::now() < deadline,
                        "timed out waiting for supervisor line: {error}"
                    );
                }
            }
        }
    }

    fn read_response(&mut self, id: &str) -> serde_json::Value {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(|v| v.as_str()) == Some(id) {
                return line;
            }
        }
    }

    /// The first `roster_update` push whose changed entries satisfy
    /// `accept` (the roster observer's convergence wait).
    fn next_roster_update<F>(&mut self, mut accept: F) -> serde_json::Value
    where
        F: FnMut(&serde_json::Value) -> bool,
    {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(
                Instant::now() < deadline,
                "no matching roster_update arrived"
            );
            let line = self.read_line();
            if line["type"] == "roster_update" && accept(&line) {
                return line;
            }
        }
    }

    /// One scripted prompt turn (`prompt_and_wait`) on the session `id`.
    fn scripted_turn(&mut self, id: &str, session_id: &str, message: &str) -> serde_json::Value {
        self.send_command(
            id,
            &serde_json::json!({
                "type": "prompt_and_wait",
                "activeSessionId": session_id,
                "message": message,
            }),
        );
        let response = self.read_response(id);
        assert_eq!(response["success"], true, "prompt {id} failed: {response}");
        response
    }
}

/// The text of every message row in a `get_messages` response.
fn message_texts(client: &mut Client, id: &str, session_id: &str) -> Vec<String> {
    client.send_command(
        id,
        &serde_json::json!({ "type": "get_messages", "activeSessionId": session_id }),
    );
    let response = client.read_response(id);
    assert_eq!(response["success"], true, "get_messages failed: {response}");
    response["data"]["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .map(|message| match message["content"].as_str() {
            Some(text) => text.to_string(),
            None => message["content"]
                .as_array()
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter_map(|b| b["text"].as_str())
                        .collect::<String>()
                })
                .unwrap_or_default(),
        })
        .collect()
}

/// The session-dir files' concatenated content (the durable transcripts).
fn session_dir_text(session_dir: &std::path::Path) -> String {
    std::fs::read_dir(session_dir)
        .expect("read session dir")
        .flatten()
        .filter(|entry| entry.path().extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .map(|entry| {
            let content = std::fs::read_to_string(entry.path()).unwrap_or_default();
            format!("--- {} ---\n{content}", entry.path().display())
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn the_fork_is_a_fully_detached_session() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);

    let script_a = dir.path().join("script-a.json");
    std::fs::write(
        &script_a,
        serde_json::json!({ "responses": [
            { "text": "original turn one", "delayMs": 10 },
        ] })
        .to_string(),
    )
    .expect("write script");
    let script_b = dir.path().join("script-b.json");
    std::fs::write(
        &script_b,
        serde_json::json!({ "responses": [
            { "text": "original turn answer", "delayMs": 10 },
        ] })
        .to_string(),
    )
    .expect("write script");
    // Client A owns the ORIGINAL session, drives the fork, and stays
    // attached to the fork (the client that ran /fork keeps its worker
    // address and sees the forked session).
    let mut client_a = Client::connect(&socket);
    client_a.send_command(
        "c1",
        &serde_json::json!({ "type": "create", "config": {
            "cwd": dir.path().to_string_lossy(),
            "sessionDir": session_dir.to_string_lossy(),
            "script": script_a.to_string_lossy(),
        } }),
    );
    let created = client_a.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let original_active = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("the original's active id")
        .to_string();
    let original_durable = created["data"]["sessionId"]
        .as_str()
        .expect("the original's durable id")
        .to_string();
    let original_file = created["data"]["sessionFile"]
        .as_str()
        .expect("the original's session file")
        .to_string();
    client_a.send_command(
        "a1",
        &serde_json::json!({ "type": "attach", "activeSessionId": original_active }),
    );
    let attached = client_a.read_response("a1");
    assert_eq!(attached["success"], true, "attach failed: {attached}");

    client_a.scripted_turn("p1", &original_active, "fork point message");

    // The roster observer: the agents-view surface that must keep seeing
    // both sessions, each owned by the worker that serves it.
    let mut observer = Client::connect(&socket);
    observer.send_command("r1", &serde_json::json!({ "type": "roster_subscribe" }));
    let subscribed = observer.read_response("r1");
    assert_eq!(subscribed["success"], true, "roster_subscribe failed");

    // THE FORK: branch before the user message; the worker moves onto the
    // forked file under its unchanged address.
    client_a.send_command(
        "g1",
        &serde_json::json!({
            "type": "get_user_messages_for_forking",
            "activeSessionId": original_active,
        }),
    );
    let points = client_a.read_response("g1");
    assert_eq!(points["success"], true, "fork points failed: {points}");
    let entry_id = points["data"]["messages"]
        .as_array()
        .and_then(|messages| {
            messages
                .iter()
                .find(|message| message["text"] == "fork point message")
                .map(|message| message["entryId"].clone())
        })
        .unwrap_or_else(|| panic!("the fork point message: {points}"));
    client_a.send_command(
        "f1",
        &serde_json::json!({
            "type": "fork",
            "activeSessionId": original_active,
            "entryId": entry_id,
        }),
    );
    let forked = client_a.read_response("f1");
    assert_eq!(forked["success"], true, "fork failed: {forked}");
    assert_eq!(
        forked["data"]["selectedText"],
        serde_json::json!("fork point message")
    );

    // The fork's identity moved: the worker serves a new durable id and
    // file under the same address.
    client_a.send_command(
        "s1",
        &serde_json::json!({ "type": "get_session_stats", "activeSessionId": original_active }),
    );
    let stats = client_a.read_response("s1");
    let fork_durable = stats["data"]["sessionId"]
        .as_str()
        .expect("fork id")
        .to_string();
    let fork_file = stats["data"]["sessionFile"]
        .as_str()
        .expect("fork file")
        .to_string();
    assert_ne!(fork_durable, original_durable, "the fork minted an id");
    assert_ne!(fork_file, original_file, "the fork wrote a new file");
    assert!(
        std::path::Path::new(&original_file).exists(),
        "the original file survives the fork"
    );

    // The supervisor's roster saw the fork (the worker's roster push): the
    // fork's row exists under the fork's durable id.
    let fork_row = observer.next_roster_update(|line| {
        line["changed"].as_array().is_some_and(|entries| {
            entries.iter().any(|entry| {
                entry["summary"]["sessionId"] == fork_durable.as_str()
                    && entry["summary"]["activeSessionId"] == original_active.as_str()
            })
        })
    });
    let fork_worker = fork_row["changed"]
        .as_array()
        .and_then(|entries| {
            entries
                .iter()
                .find(|entry| entry["summary"]["sessionId"] == fork_durable.as_str())
        })
        .map(|entry| entry["workerId"].clone())
        .expect("the fork row names its worker");
    assert_eq!(fork_worker, original_active.as_str());

    // THE SWAP PIN: the row the fork worker previously owned for the same
    // address described the ORIGINAL session — it is dead now (the fork
    // worker serves the fork, and the original file's open must not find a
    // stale "live" row). A stale row here is what re-presents the
    // original as the fork worker's live root and what later wakes by
    // address would resolve to the wrong file.
    observer.send_command("r2", &serde_json::json!({ "type": "roster_subscribe" }));
    let snapshot = observer.read_response("r2");
    assert_eq!(snapshot["success"], true, "re-subscribe failed");
    let roster = snapshot["data"]["roster"].as_array().expect("roster");
    let stale = roster
        .iter()
        .find(|entry| entry["agentId"] == original_durable.as_str());
    assert!(
        stale.is_none(),
        "the fork's swap must retire the stale row for the original: {stale:?}"
    );

    // THE ISOLATION PIN: a create over the ORIGINAL file opens the
    // ORIGINAL — a worker of its own, not the fork worker reused for the
    // path it no longer serves.
    let mut client_b = Client::connect(&socket);
    client_b.send_command(
        "c2",
        &serde_json::json!({
            "type": "create",
            "sessionPath": original_file,
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": session_dir.to_string_lossy(),
                "script": script_b.to_string_lossy(),
            },
        }),
    );
    let reopened = client_b.read_response("c2");
    assert_eq!(reopened["success"], true, "re-open failed: {reopened}");
    let reopened_id = reopened["data"]["id"]
        .as_str()
        .or_else(|| reopened["data"]["sessionId"].as_str())
        .expect("the re-opened session's id")
        .to_string();
    let reopened_durable = reopened["data"]["sessionId"]
        .as_str()
        .expect("the re-opened durable id")
        .to_string();

    client_b.send_command(
        "a2",
        &serde_json::json!({ "type": "attach", "activeSessionId": reopened_id }),
    );
    let attached_b = client_b.read_response("a2");
    assert_eq!(attached_b["success"], true, "attach B failed: {attached_b}");

    // The message the operator sent in the ORIGINAL session.
    client_b.scripted_turn("p2", &reopened_id, "message for the original");

    // The leak evidence: the fork's transcript and both files' durable
    // content, gathered before the pins so every failure names the full
    // matrix.
    let fork_texts = message_texts(&mut client_a, "m1", &original_active);
    let texts = session_dir_text(&session_dir);

    // PIN 1: the re-open of the original resolved to the ORIGINAL session
    // (its own worker), never the fork.
    assert_eq!(
        reopened_durable, original_durable,
        "the create over the original file must open the original, not the fork (the values print above)"
    );
    assert_ne!(
        reopened_id, original_active,
        "the original's re-open must not reuse the fork worker's address"
    );

    // PIN 2 (the operator's report): the original's message never lands
    // in the fork's transcript.
    assert!(
        !fork_texts
            .iter()
            .any(|text| text.contains("message for the original")),
        "the fork received the original's message: {fork_texts:?}\nsession files: {texts}"
    );
    assert!(
        !fork_file_text(&fork_file).contains("message for the original"),
        "the fork's file received the original's message"
    );
    assert!(
        std::fs::read_to_string(&original_file)
            .unwrap_or_default()
            .contains("message for the original"),
        "the original's message must reach the original's file"
    );

    // THE REVERSE PIN: the fork's own message never lands in the original.
    client_a.scripted_turn("p3", &original_active, "message for the fork");
    let original_texts = message_texts(&mut client_b, "m2", &reopened_id);
    assert!(
        !original_texts
            .iter()
            .any(|text| text.contains("message for the fork")),
        "the original received the fork's message: {original_texts:?}"
    );
    assert!(
        !std::fs::read_to_string(&original_file)
            .unwrap_or_default()
            .contains("message for the fork"),
        "the original's file received the fork's message"
    );
    assert!(
        fork_file_text(&fork_file).contains("message for the fork"),
        "the fork's own message must reach the fork's file"
    );

    // THE INDEPENDENCE PIN: the fork's client keeps serving its own turns.
    let fork_texts = message_texts(&mut client_a, "m3", &original_active);
    assert!(
        fork_texts
            .iter()
            .any(|text| text.contains("message for the fork")),
        "the fork's own message must appear in the fork's transcript: {fork_texts:?}"
    );
    assert!(
        fork_texts.iter().any(|text| text.contains("original turn one")),
        "the fork's turn must answer on the fork's transcript (the replacement restarts the script): {fork_texts:?}"
    );

    // THE VISIBILITY PIN: the roster carries BOTH sessions, each owned by
    // the worker that serves it (the family edges are not the bug; the
    // routing was).
    observer.send_command("r3", &serde_json::json!({ "type": "roster_subscribe" }));
    let snapshot = observer.read_response("r3");
    assert_eq!(snapshot["success"], true, "final subscribe failed");
    let roster = snapshot["data"]["roster"].as_array().expect("roster");
    let original_row = roster
        .iter()
        .find(|entry| entry["agentId"] == original_durable.as_str())
        .expect("the original's roster row after its re-open");
    assert_eq!(
        original_row["workerId"],
        reopened_id.as_str(),
        "the original's row names its own worker: {original_row:?}"
    );
    let fork_row = roster
        .iter()
        .find(|entry| entry["agentId"] == fork_durable.as_str())
        .expect("the fork's roster row");
    assert_eq!(
        fork_row["workerId"],
        original_active.as_str(),
        "the fork's row names the fork worker: {fork_row:?}"
    );

    // THE STALE-BINDING PIN: the fork worker dies, and its old address
    // must NOT rebind into the original's worker — the address's binding
    // follows the fork (the fork's file), so the stale id answers the
    // unknown-session failure instead of landing the fork's client in
    // the original.
    client_a.send_command(
        "k1",
        &serde_json::json!({ "type": "kill", "activeSessionId": original_active }),
    );
    let killed = client_a.read_response("k1");
    assert_eq!(killed["success"], true, "kill failed: {killed}");
    client_a.send_command(
        "p4",
        &serde_json::json!({
            "type": "prompt",
            "activeSessionId": original_active,
            "message": "must not reach the original",
        }),
    );
    let stale = client_a.read_response("p4");
    assert_eq!(
        stale["success"], false,
        "the fork's stale id must not deliver: {stale}"
    );
    assert!(
        stale["error"]
            .as_str()
            .unwrap_or_default()
            .contains("Unknown active session"),
        "the stale id answers the unknown-session failure: {stale}"
    );
    assert!(
        !std::fs::read_to_string(&original_file)
            .unwrap_or_default()
            .contains("must not reach the original"),
        "the stale id's message must not reach the original"
    );
    assert!(
        !message_texts(&mut client_b, "m4", &reopened_id)
            .iter()
            .any(|text| text.contains("must not reach the original")),
        "the original's transcript must stay clean of the stale id's message"
    );
}

/// One session file's content.
fn fork_file_text(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

/// Wait until the supervisor socket accepts connections (a restarted
/// supervisor parks on the stale socket file for up to a second before
/// replacing it, so file existence is not readiness).
fn wait_socket_accepts(socket: &std::path::Path) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if UnixStream::connect(socket).is_ok() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "the restarted supervisor never accepted connections"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// FINDING 3's restart pin: a daemon restart AFTER a failed identity
/// persist, BEFORE any new roster write — the boot serves the NEW identity
/// (never replays the old session) because the boot paths reconcile the
/// resident from the live worker state before the routing opens.
#[test]
fn a_restart_after_a_failed_identity_persist_serves_the_moved_session() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("agent dir");

    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        serde_json::json!({ "responses": [
            { "text": "original turn one", "delayMs": 10 },
            { "text": "restart turn answer", "delayMs": 10 },
        ] })
        .to_string(),
    )
    .expect("write script");

    // Supervisor A: the original session, the fork, the failed persist.
    let mut supervisor_a = spawn_supervisor_raw(&socket, &agent_dir);
    let mut client_a = Client::connect(&socket);
    // The roster observer: the fork's supervisor-side convergence signal
    // (the worker's roster push carries the identity follow; the pins
    // assert the settled state, so the test waits for the row like every
    // other roster-observing surface).
    let mut observer = Client::connect(&socket);
    observer.send_command("r1", &serde_json::json!({ "type": "roster_subscribe" }));
    assert_eq!(
        observer.read_response("r1")["success"],
        true,
        "roster_subscribe failed"
    );
    client_a.send_command(
        "c1",
        &serde_json::json!({ "type": "create", "config": {
            "cwd": dir.path().to_string_lossy(),
            "sessionDir": session_dir.to_string_lossy(),
            "script": script_path.to_string_lossy(),
        } }),
    );
    let created = client_a.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let address = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("the worker address")
        .to_string();
    let original_durable = created["data"]["sessionId"]
        .as_str()
        .expect("the original's durable id")
        .to_string();
    let original_file = created["data"]["sessionFile"]
        .as_str()
        .expect("the original's file")
        .to_string();
    client_a.scripted_turn("p1", &address, "fork point message");

    // The persisted record this boot owns: save the pre-fork record (the
    // stale identity the restart must NOT serve), then break the record
    // path so the fork's identity persist fails.
    let descriptor_dir = pa_daemon::descriptor::descriptor_dir(&agent_dir, &socket);
    let descriptor_path = descriptor_dir.join(format!("{address}.json"));
    let stale_record = std::fs::read_to_string(&descriptor_path)
        .expect("the worker's persisted record before the fork");
    std::fs::remove_file(&descriptor_path).expect("remove the record file");
    std::fs::create_dir_all(&descriptor_path).expect("the record path takes a directory");

    // The fork: the worker moves onto the forked file; the identity
    // persist fails against the directory (the in-memory identity moved,
    // the marker armed).
    client_a.send_command(
        "g1",
        &serde_json::json!({
            "type": "get_user_messages_for_forking",
            "activeSessionId": address,
        }),
    );
    let points = client_a.read_response("g1");
    let entry_id = points["data"]["messages"]
        .as_array()
        .and_then(|messages| {
            messages
                .iter()
                .find(|message| message["text"] == "fork point message")
                .map(|message| message["entryId"].clone())
        })
        .unwrap_or_else(|| panic!("the fork point message: {points}"));
    client_a.send_command(
        "f1",
        &serde_json::json!({
            "type": "fork",
            "activeSessionId": address,
            "entryId": entry_id,
        }),
    );
    let forked = client_a.read_response("f1");
    assert_eq!(forked["success"], true, "fork failed: {forked}");
    client_a.send_command(
        "s1",
        &serde_json::json!({ "type": "get_session_stats", "activeSessionId": address }),
    );
    let stats = client_a.read_response("s1");
    let fork_file = stats["data"]["sessionFile"]
        .as_str()
        .expect("the fork's file")
        .to_string();
    let fork_durable = stats["data"]["sessionId"]
        .as_str()
        .expect("the fork's durable id")
        .to_string();
    assert_ne!(fork_file, original_file, "the fork moved the worker");
    // The supervisor-side convergence wait: the fork's roster push carries
    // the identity follow (the worker's response does NOT wait for its
    // landing — the TS-parity async flush — so the pins assert the
    // settled identity, never the in-flight window).
    let _ = observer.next_roster_update(|line| {
        line["changed"].as_array().is_some_and(|entries| {
            entries.iter().any(|entry| {
                entry["summary"]["sessionId"] == fork_durable.as_str()
                    && entry["summary"]["activeSessionId"] == address.as_str()
            })
        })
    });

    // The LIVE isolation still holds with the failed persist (the
    // in-memory identity follows the worker).
    let mut prober = Client::connect(&socket);
    prober.send_command(
        "c2",
        &serde_json::json!({
            "type": "create",
            "sessionPath": original_file,
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": session_dir.to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let reopened = prober.read_response("c2");
    assert_eq!(reopened["success"], true, "re-open failed: {reopened}");
    assert_eq!(
        reopened["data"]["sessionId"], original_durable,
        "the original's re-open serves the original, not the fork"
    );
    prober.send_command(
        "k2",
        &serde_json::json!({ "type": "kill", "activeSessionId": reopened["data"]["id"] }),
    );
    assert_eq!(prober.read_response("k2")["success"], true, "kill failed");

    // THE RESTART: the stale record back on disk (the boot's only word on
    // the worker is the pre-fork identity), the supervisor killed, the
    // WORKER left alive, a fresh supervisor over the same agent dir.
    std::fs::remove_dir_all(&descriptor_path).expect("clear the record path");
    std::fs::write(&descriptor_path, &stale_record).expect("restore the stale record");
    supervisor_a.kill().expect("kill supervisor A");
    let _ = supervisor_a.wait();

    let mut supervisor_b = spawn_supervisor_raw(&socket, &agent_dir);
    let _daemon_guard = DaemonKillOnDrop {
        child: &mut supervisor_b,
    };
    wait_socket_accepts(&socket);

    // The boot adopts the live worker and reconciles from its live state
    // BEFORE the routing opens: the address serves the FORK.
    let mut client_b = Client::connect(&socket);
    let deadline = Instant::now() + Duration::from_secs(15);
    let restarted = loop {
        assert!(Instant::now() < deadline, "the worker never re-registered");
        client_b.send_command(
            "s2",
            &serde_json::json!({ "type": "get_session_stats", "activeSessionId": address }),
        );
        let stats = client_b.read_response("s2");
        if stats["success"] == true {
            break stats;
        }
        assert_eq!(stats["success"], false, "the failed stats answer: {stats}");
    };
    assert_eq!(
        restarted["data"]["sessionFile"], fork_file,
        "the restart serves the fork's file (the boot reconciled the identity)"
    );
    assert_eq!(restarted["data"]["sessionId"], fork_durable);

    // The reconciliation re-persisted the repaired record: a future
    // restart reads the FORK's identity, never the original's.
    let repaired_record = std::fs::read_to_string(&descriptor_path).expect("the repaired record");
    assert!(
        repaired_record.contains(&fork_durable),
        "the durable record names the fork: {repaired_record}"
    );
    assert!(
        !repaired_record.contains(&format!("\"{original_durable}\"")),
        "the durable record dropped the original's identity"
    );

    // THE ISOLATION AT BOOT: the original's routes still open the
    // original, never the fork worker.
    let mut client_c = Client::connect(&socket);
    client_c.send_command(
        "c3",
        &serde_json::json!({
            "type": "create",
            "sessionPath": original_file,
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": session_dir.to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let reopened = client_c.read_response("c3");
    assert_eq!(
        reopened["success"], true,
        "the boot re-open failed: {reopened}"
    );
    assert_eq!(
        reopened["data"]["sessionId"], original_durable,
        "the boot's create over the original opens the original, not the fork"
    );
    assert_ne!(
        reopened["data"]["id"], address,
        "the original's open never reuses the fork worker's address"
    );
    client_c.send_command(
        "a3",
        &serde_json::json!({ "type": "attach", "activeSessionId": reopened["data"]["id"] }),
    );
    let attached_c = client_c.read_response("a3");
    assert_eq!(attached_c["success"], true, "attach C failed: {attached_c}");
    let reopened_id = reopened["data"]["id"]
        .as_str()
        .expect("the re-opened id")
        .to_string();
    client_c.scripted_turn("p3", &reopened_id, "message for the original");
    assert!(
        !fork_file_text(&fork_file).contains("message for the original"),
        "the original's message never reaches the fork's file"
    );

    // The fork's own sends still flow its own way after the restart.
    client_b.scripted_turn("p4", &address, "message for the fork");
    let fork_texts = message_texts(&mut client_b, "m1", &address);
    assert!(
        fork_texts
            .iter()
            .any(|text| text.contains("message for the fork")),
        "the fork's own message reaches its transcript: {fork_texts:?}"
    );
    assert!(
        !std::fs::read_to_string(&original_file)
            .unwrap_or_default()
            .contains("message for the fork"),
        "the fork's message never reaches the original's file"
    );
}

/// One raw supervisor child (no drop-time kill: the restart test manages
/// the process itself). The timeout panic path cannot wait on the child;
/// the test process exits immediately afterwards, reaping it.
#[allow(clippy::zombie_processes)]
fn spawn_supervisor_raw(socket: &std::path::Path, agent_dir: &std::path::Path) -> Child {
    let binary = env!("CARGO_BIN_EXE_pa-daemon");
    let child = Command::new(binary)
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
        .spawn()
        .expect("spawn pa-daemon supervisor");
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if socket.exists() {
            return child;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("supervisor socket never appeared");
}

/// Kills the supervisor at scope exit (the restart test's supervisor B).
struct DaemonKillOnDrop<'a> {
    child: &'a mut Child,
}

impl Drop for DaemonKillOnDrop<'_> {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
