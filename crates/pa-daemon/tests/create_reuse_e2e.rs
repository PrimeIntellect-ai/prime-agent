//! The create-open reuse seam e2e: an open of a session file a live
//! worker already serves answers the LIVE binding (multi-client attach)
//! instead of launching a second worker over the same file — a launch the
//! runtime session lease would reject with `Session is already active`
//! (Kevin's reproducer: opening a saved session whose worker was already
//! running). Also covers the lease owner id stamp (the rejection the seam
//! cannot remove must still name the LIVE worker, never an id inherited
//! from an ancestor environment) and the dead-worker rebind on the create
//! path (the #2575 supersede, driven by an open of the superseded file).
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

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
fn spawn_daemon(socket: &Path, agent_dir: &Path, poison_lease_owner: Option<&str>) -> Daemon {
    let mut command = Command::new(env!("CARGO_BIN_EXE_pa-daemon"));
    command
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
        );
    if let Some(owner) = poison_lease_owner {
        // An ancestor's lease owner id (a CLI running inside a worker's
        // environment): without the per-worker stamp every lease the
        // daemon's workers write would name this stale id instead.
        command.env(pa_daemon::lease::SESSION_LEASE_OWNER_ID_ENV, owner);
    }
    let child = command.spawn().expect("spawn pa-daemon supervisor");
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
    fn connect(socket: &Path) -> Self {
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

    fn send_command(&mut self, id: &str, command: Value) {
        let mut line = serde_json::to_string(&json!({
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

    fn read_line(&mut self) -> Value {
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
                Ok(_) if line.trim().is_empty() => continue,
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

    fn read_response(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(|v| v.as_str()) == Some(id) {
                return line;
            }
        }
    }

    /// Read lines until one has the given `type`; other lines are skipped.
    fn read_line_of_type(&mut self, line_type: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            assert!(Instant::now() < deadline, "no {line_type} line arrived");
            let line = self.read_line();
            if line["type"] == line_type {
                return line;
            }
        }
    }

    /// Drive one prompt to its final scripted text: send, await the ack,
    /// then read streamed session events to the turn end.
    fn prompt_and_final_text(&mut self, id: &str, command: Value) -> String {
        self.send_command(id, command);
        let mut final_text = String::new();
        let mut acked = false;
        let mut turn_ended = false;
        let deadline = Instant::now() + Duration::from_secs(20);
        while !(acked && turn_ended) {
            assert!(Instant::now() < deadline, "prompt {id} never settled");
            let line = self.read_line();
            if line.get("id").and_then(|v| v.as_str()) == Some(id) {
                assert_eq!(line["success"], true, "prompt failed: {line}");
                acked = true;
                continue;
            }
            if line["type"] == "session_event" {
                match line["event"]["type"].as_str() {
                    Some("message_end") => {
                        final_text = line["event"]["message"]["content"]
                            .as_str()
                            .unwrap_or_default()
                            .to_string();
                    }
                    Some("turn_end") => turn_ended = true,
                    _ => {}
                }
            }
        }
        final_text
    }
}

fn write_script(dir: &Path, responses: &[&str]) -> PathBuf {
    let script_path = dir.join("script.json");
    let scripted: Vec<Value> = responses
        .iter()
        .map(|text| json!({ "text": text }))
        .collect();
    std::fs::write(&script_path, json!({ "responses": scripted }).to_string())
        .expect("write script");
    script_path
}

/// The session's durable file (TS `get_session_stats` -> sessionFile).
fn session_file_of(client: &mut Client, id: &str, request_id: &str) -> String {
    client.send_command(
        request_id,
        json!({ "type": "get_session_stats", "activeSessionId": id }),
    );
    let stats = client.read_response(request_id);
    assert_eq!(stats["success"], true, "stats failed: {stats}");
    stats["data"]["sessionFile"]
        .as_str()
        .expect("session file in stats")
        .to_string()
}

/// The active id a create response answered (the summary's `id`, the same
/// field a pane attaches by).
fn create_session(client: &mut Client, request_id: &str, config: &Value) -> (String, Value) {
    client.send_command(request_id, json!({ "type": "create", "config": config }));
    let created = client.read_response(request_id);
    assert_eq!(created["success"], true, "create failed: {created}");
    let id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id in create response")
        .to_string();
    (id, created)
}

/// Kevin's reproducer, green: opening a saved session whose worker is
/// already live answers the LIVE binding (the same active id the first
/// pane holds) — never `Session is already active` — and the roster keeps
/// exactly one session for the file.
#[test]
fn create_over_a_live_worker_answers_the_live_binding() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir, None);

    let script_path = write_script(dir.path(), &["first scripted", "second scripted"]);
    let create_config = json!({
        "cwd": dir.path().to_string_lossy(),
        "sessionDir": agent_dir.join("sessions").to_string_lossy(),
        "script": script_path.to_string_lossy(),
    });

    // The session's first worker: one pane creates it and attaches.
    let mut first_pane = Client::connect(&socket);
    let (first_id, _created) = create_session(&mut first_pane, "c1", &create_config);
    first_pane.send_command(
        "a1",
        json!({ "type": "attach", "activeSessionId": first_id }),
    );
    let attached = first_pane.read_response("a1");
    assert_eq!(attached["success"], true, "attach failed: {attached}");
    let live_id = attached["data"]["activeSessionId"]
        .as_str()
        .or_else(|| attached["data"]["id"].as_str())
        .expect("active id in attach result")
        .to_string();
    let session_file = session_file_of(&mut first_pane, &live_id, "s1");

    // The reproducer: a second pane opens the SAME saved session. The
    // daemon must answer the live binding (an attach), not reject the
    // create with `Session is already active in <stale id>`.
    let mut second_pane = Client::connect(&socket);
    second_pane.send_command(
        "c2",
        json!({
            "type": "create",
            "sessionPath": session_file,
            "config": create_config,
        }),
    );
    let reopened = second_pane.read_response("c2");
    assert_eq!(
        reopened["success"], true,
        "opening an already-active session must attach, not reject: {reopened}"
    );
    let reused_id = reopened["data"]["id"]
        .as_str()
        .or_else(|| reopened["data"]["sessionId"].as_str())
        .expect("session id in the reused create response")
        .to_string();
    assert_eq!(
        reused_id, live_id,
        "the open must answer the LIVE binding's active id"
    );

    // The reused binding routes: the second pane attaches by it and a
    // prompt runs its turn (multi-client attach, not a zombie id).
    second_pane.send_command(
        "a2",
        json!({ "type": "attach", "activeSessionId": reused_id }),
    );
    let second_attached = second_pane.read_response("a2");
    assert_eq!(
        second_attached["success"], true,
        "attach by the reused id failed: {second_attached}"
    );
    let first_text = second_pane.prompt_and_final_text(
        "p1",
        json!({ "type": "prompt", "activeSessionId": reused_id, "message": "hi" }),
    );
    assert_eq!(first_text, "first scripted");

    // Exactly one session serves the file: the reuse launched nothing.
    second_pane.send_command("l1", json!({ "type": "list", "all": true }));
    let listed = second_pane.read_response("l1");
    assert_eq!(listed["success"], true, "list failed: {listed}");
    let sessions = listed["data"]["sessions"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let for_file: Vec<&Value> = sessions
        .iter()
        .filter(|row| row.get("sessionFile").and_then(Value::as_str) == Some(session_file.as_str()))
        .collect();
    assert_eq!(
        for_file.len(),
        1,
        "the reuse must not mint a second worker for the file: {sessions:?}"
    );
}

/// The lease owner id is stamped per worker (TS daemon-supervisor mints it
/// at launch): even a daemon that inherited a stale
/// `PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID` from an ancestor writes
/// leases naming the LIVE worker — so a rejection the reuse seam cannot
/// remove (a genuinely foreign lease holder) names a real binding.
#[test]
fn the_lease_owner_names_the_live_worker_not_a_stale_inherited_id() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir, Some("stale-owner-245ddb974b6d"));

    let script_path = write_script(dir.path(), &["one scripted"]);
    let create_config = json!({
        "cwd": dir.path().to_string_lossy(),
        "sessionDir": agent_dir.join("sessions").to_string_lossy(),
        "script": script_path.to_string_lossy(),
    });
    let mut client = Client::connect(&socket);
    let (worker_id, _created) = create_session(&mut client, "c1", &create_config);
    let session_file = session_file_of(&mut client, &worker_id, "s1");

    // The lease the live worker wrote for the session file. The lease key
    // is a hash of the canonical path, but a file acquired before it
    // existed is keyed by its raw path (the canonicalize fallback), so the
    // test locates the lease by the owner's sessionPath instead of
    // recomputing the key.
    let leases_dir = agent_dir.join("session-leases");
    let owner: Value = std::fs::read_dir(&leases_dir)
        .expect("session-leases directory")
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| std::fs::read_to_string(entry.path().join("owner.json")).ok())
        .map(|content| serde_json::from_str::<Value>(&content).expect("owner.json"))
        .find(|owner| owner["sessionPath"].as_str() == Some(session_file.as_str()))
        .unwrap_or_else(|| panic!("no session lease for {session_file}"));
    let named = owner["activeSessionId"]
        .as_str()
        .expect("the lease names its owner session");
    assert_eq!(
        named, worker_id,
        "the lease must name the LIVE worker's active id, not an inherited one"
    );
}

/// A stale binding (the file's previous worker is dead) keeps the launch
/// path: the open of the superseded file succeeds, mints the successor,
/// and the #2575 supersede re-attaches the old pane (the create-open is
/// never a bare rejection in this case either).
#[test]
fn create_over_a_dead_workers_file_launches_and_rebinds() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir, None);

    let script_path = write_script(dir.path(), &["first scripted", "second scripted"]);
    let create_config = json!({
        "cwd": dir.path().to_string_lossy(),
        "sessionDir": agent_dir.join("sessions").to_string_lossy(),
        "script": script_path.to_string_lossy(),
    });

    let mut first_pane = Client::connect(&socket);
    let (first_id, _created) = create_session(&mut first_pane, "c1", &create_config);
    first_pane.send_command(
        "a1",
        json!({ "type": "attach", "activeSessionId": first_id }),
    );
    let attached = first_pane.read_response("a1");
    assert_eq!(attached["success"], true, "attach failed: {attached}");
    let old_id = attached["data"]["activeSessionId"]
        .as_str()
        .or_else(|| attached["data"]["id"].as_str())
        .expect("active id in attach result")
        .to_string();
    let session_file = session_file_of(&mut first_pane, &old_id, "s1");

    // The worker dies (registry entry and descriptor gone): the binding
    // left behind is stale.
    let mut driver = Client::connect(&socket);
    driver.send_command("k1", json!({ "type": "kill", "activeSessionId": old_id }));
    let killed = driver.read_response("k1");
    assert_eq!(killed["success"], true, "kill failed: {killed}");

    // The open of the superseded file succeeds (the dead holder's lease
    // is reclaimed) and mints the successor binding.
    driver.send_command(
        "c2",
        json!({
            "type": "create",
            "sessionPath": session_file,
            "config": create_config,
        }),
    );
    let recreated = driver.read_response("c2");
    assert_eq!(
        recreated["success"], true,
        "opening a dead worker's session file must launch a successor, not reject: {recreated}"
    );
    let new_id = recreated["data"]["id"]
        .as_str()
        .or_else(|| recreated["data"]["sessionId"].as_str())
        .expect("session id in the successor create response")
        .to_string();
    assert_ne!(new_id, old_id, "the successor mints a new active id");

    // The supersede notice reaches the pane still attached to the old id
    // (the #2575 seam, driven by this create).
    let binding = first_pane.read_line_of_type("session_binding");
    assert_eq!(binding["previousActiveSessionId"], old_id.as_str());
    assert_ne!(
        binding["activeSessionId"].as_str(),
        Some(old_id.as_str()),
        "the binding event advertises the successor"
    );
    assert_eq!(binding["sessionFile"].as_str(), Some(session_file.as_str()));
}
