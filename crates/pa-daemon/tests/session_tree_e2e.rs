//! Session-tree worker commands against the real `pa-daemon` binary:
//! `get_session_tree`, `set_session_entry_label`,
//! `get_user_messages_for_forking`, `navigate_tree` (plain branch move,
//! leaf no-op, branch summary, unknown target), and `fork`. The wire shapes
//! are the TS daemon-protocol contract; the leaf moves are asserted through
//! the store's `get_messages` read of the moved branch.
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
    fn connect(socket: &std::path::Path) -> (Self, serde_json::Value) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(stream) = UnixStream::connect(socket) {
                let writer = stream.try_clone().expect("clone stream");
                let mut client = Client {
                    reader: BufReader::new(stream),
                    writer,
                };
                let hello = client.read_line();
                assert_eq!(hello["type"], "daemon_hello", "expected hello: {hello}");
                return (client, hello);
            } else if Instant::now() > deadline {
                panic!("daemon socket never accepted");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn send(&mut self, value: &serde_json::Value) {
        let mut line = serde_json::to_string(value).expect("serialize");
        line.push('\n');
        self.writer.write_all(line.as_bytes()).expect("write");
        self.writer.flush().expect("flush");
    }

    fn send_command(&mut self, id: &str, command: serde_json::Value) {
        self.send(&serde_json::json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        }));
    }

    fn read_line(&mut self) -> serde_json::Value {
        let mut line = String::new();
        let read = self
            .reader
            .read_line(&mut line)
            .expect("read daemon line within the deadline");
        assert!(read > 0, "daemon closed the socket");
        serde_json::from_str(line.trim()).expect("a valid daemon line")
    }

    fn read_response(&mut self, id: &str) -> serde_json::Value {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            assert!(Instant::now() < deadline, "no response for {id} arrived");
            let line = self.read_line();
            if line["type"] == "response" && line["id"] == id {
                return line;
            }
        }
    }
}

/// The text of every message row in a `get_messages` response.
fn message_texts(response: &serde_json::Value) -> Vec<String> {
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

/// One scripted prompt turn (prompt, then wait out the turn events).
fn scripted_turn(client: &mut Client, session_id: &str, message: &str, id: &str) {
    client.send_command(
        id,
        serde_json::json!({
            "type": "prompt_and_wait",
            "activeSessionId": session_id,
            "message": message,
        }),
    );
    let response = client.read_response(id);
    assert_eq!(response["success"], true, "prompt {id} failed: {response}");
}

#[test]
fn session_tree_commands_over_the_supervisor_wire() {
    fn entry_id(node: &serde_json::Value) -> &str {
        node["entry"]["id"].as_str().expect("entry id")
    }
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, _hello) = Client::connect(&socket);

    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        serde_json::json!({
            "responses": [
                { "text": "first answer", "delayMs": 10 },
                { "text": "second answer", "delayMs": 10 },
            ],
            "branchSummary": { "responses": [
                { "summary": "explored the second branch", "delayMs": 10 },
            ] },
        })
        .to_string(),
    )
    .expect("write script");
    client.send_command(
        "c1",
        serde_json::json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": session_dir.to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();

    scripted_turn(&mut client, &session_id, "first question", "p1");
    scripted_turn(&mut client, &session_id, "second question", "p2");

    // The tree: every entry in file order plus the leaf id.
    client.send_command(
        "t1",
        serde_json::json!({ "type": "get_session_tree", "activeSessionId": session_id }),
    );
    let tree = client.read_response("t1");
    assert_eq!(tree["success"], true, "get_session_tree failed: {tree}");
    let flat = tree["data"]["flatNodes"].as_array().expect("flatNodes");
    assert!(flat.len() >= 4, "entries present: {flat:?}");
    let leaf_id = tree["data"]["leafId"].as_str().expect("leafId").to_string();
    assert!(!leaf_id.is_empty());
    // The flat nodes are wire entries with id/parentId.
    assert!(flat.iter().all(|node| node["entry"]["id"].is_string()));
    let first_user = flat
        .iter()
        .find(|node| {
            node["entry"]["type"] == "message"
                && node["entry"]["message"]["role"] == "user"
                && node["entry"]["message"]["content"].as_str() == Some("first question")
        })
        .expect("the first user message node");
    let first_user_id = entry_id(first_user).to_string();
    let first_assistant = flat
        .iter()
        .find(|node| {
            node["entry"]["type"] == "message" && node["entry"]["message"]["role"] == "assistant"
        })
        .expect("the first assistant message node");
    let first_assistant_id = entry_id(first_assistant).to_string();
    let second_user = flat
        .iter()
        .find(|node| {
            node["entry"]["type"] == "message"
                && node["entry"]["message"]["role"] == "user"
                && node["entry"]["message"]["content"].as_str() == Some("second question")
        })
        .expect("the second user message node");
    let second_user_id = entry_id(second_user).to_string();

    // Labels persist and surface in the flat tree.
    client.send_command(
        "l1",
        serde_json::json!({
            "type": "set_session_entry_label",
            "activeSessionId": session_id,
            "entryId": first_user_id,
            "label": "checkpoint",
        }),
    );
    let labeled = client.read_response("l1");
    assert_eq!(labeled["success"], true, "label failed: {labeled}");
    client.send_command(
        "t2",
        serde_json::json!({ "type": "get_session_tree", "activeSessionId": session_id }),
    );
    let tree = client.read_response("t2");
    let labeled_node = tree["data"]["flatNodes"]
        .as_array()
        .expect("flatNodes")
        .iter()
        .find(|node| node["entry"]["id"] == first_user_id.as_str())
        .expect("the labeled node");
    assert_eq!(labeled_node["label"], serde_json::json!("checkpoint"));

    // Fork points: the two user messages with their text.
    client.send_command(
        "f0",
        serde_json::json!({
            "type": "get_user_messages_for_forking",
            "activeSessionId": session_id,
        }),
    );
    let messages = client.read_response("f0");
    assert_eq!(messages["success"], true, "fork points failed: {messages}");
    let texts: Vec<&str> = messages["data"]["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .map(|message| message["text"].as_str().expect("text"))
        .collect();
    assert_eq!(texts, vec!["first question", "second question"]);

    // Unknown target errors like the TS session manager.
    client.send_command(
        "n0",
        serde_json::json!({
            "type": "navigate_tree",
            "activeSessionId": session_id,
            "targetId": "no-such-entry",
        }),
    );
    let missing = client.read_response("n0");
    assert_eq!(missing["success"], false);
    assert_eq!(missing["error"], "Entry no-such-entry not found");

    // Navigating to the current leaf is a no-op.
    client.send_command(
        "n1",
        serde_json::json!({
            "type": "navigate_tree",
            "activeSessionId": session_id,
            "targetId": leaf_id,
        }),
    );
    let noop = client.read_response("n1");
    assert_eq!(noop["success"], true, "leaf no-op failed: {noop}");
    assert_eq!(noop["data"]["cancelled"], serde_json::json!(false));
    assert!(noop["data"].get("editorText").is_none());

    // Navigate to the first assistant message: a plain branch move (the
    // second turn's entries are abandoned on their branch).
    client.send_command(
        "n2",
        serde_json::json!({
            "type": "navigate_tree",
            "activeSessionId": session_id,
            "targetId": first_assistant_id,
        }),
    );
    let navigated = client.read_response("n2");
    assert_eq!(navigated["success"], true, "navigation failed: {navigated}");
    assert!(navigated["data"].get("editorText").is_none());
    client.send_command(
        "m1",
        serde_json::json!({ "type": "get_messages", "activeSessionId": session_id }),
    );
    let messages = client.read_response("m1");
    let texts: Vec<String> = message_texts(&messages);
    assert!(texts.iter().any(|text| text.contains("first question")));
    assert!(
        !texts.iter().any(|text| text.contains("second question")),
        "the abandoned branch dropped: {texts:?}"
    );

    // Navigate to the first user message WITH a branch summary: the
    // abandoned branch is summarized (scripted), the summary entry lands
    // on the new branch, and the user text returns to the editor.
    client.send_command(
        "n3",
        serde_json::json!({
            "type": "navigate_tree",
            "activeSessionId": session_id,
            "targetId": first_user_id,
            "summarize": true,
        }),
    );
    let summarized = client.read_response("n3");
    assert_eq!(
        summarized["success"], true,
        "summarized navigation failed: {summarized}"
    );
    assert_eq!(
        summarized["data"]["editorText"],
        serde_json::json!("first question")
    );
    assert_eq!(
        summarized["data"]["summaryEntry"]["summary"],
        serde_json::json!("explored the second branch")
    );
    // The branch_summary entry persisted to the session file.
    let mut saw_branch_summary = false;
    for entry in std::fs::read_dir(&session_dir)
        .expect("read session dir")
        .flatten()
    {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        saw_branch_summary |= content.contains("\"type\":\"branch_summary\"");
    }
    assert!(
        saw_branch_summary,
        "the branch_summary entry persisted to the session file"
    );

    // Fork from the second user message: a new session file with the path
    // up to that point, and the message text back as selectedText.
    client.send_command(
        "f1",
        serde_json::json!({
            "type": "fork",
            "activeSessionId": session_id,
            "entryId": second_user_id,
        }),
    );
    let forked = client.read_response("f1");
    assert_eq!(forked["success"], true, "fork failed: {forked}");
    assert_eq!(
        forked["data"]["selectedText"],
        serde_json::json!("second question")
    );
    // The worker's session is now the forked branch: the second turn's
    // messages are the pre-fork path.
    client.send_command(
        "m2",
        serde_json::json!({ "type": "get_messages", "activeSessionId": session_id }),
    );
    let messages = client.read_response("m2");
    let texts: Vec<String> = message_texts(&messages);
    assert!(texts.iter().any(|text| text.contains("first question")));
    assert!(
        !texts.iter().any(|text| text.contains("second question")),
        "the fork cut before the target message: {texts:?}"
    );
    // The fork created a second session file.
    let session_files: Vec<_> = std::fs::read_dir(&session_dir)
        .expect("read session dir")
        .flatten()
        .filter(|entry| entry.path().extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .collect();
    assert!(
        session_files.len() >= 2,
        "the fork wrote a new session file: {} files",
        session_files.len()
    );
}

/// One raw private-frame client for the session worker's own socket.
struct WorkerClient {
    stream: UnixStream,
}

impl WorkerClient {
    fn connect(socket: &std::path::Path) -> (Self, serde_json::Value) {
        let stream = UnixStream::connect(socket).expect("connect worker socket");
        stream
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        let mut client = WorkerClient { stream };
        let (header, payload) = client.read_frame();
        assert_eq!(header["outboundType"], "daemon_hello", "worker hello");
        let hello: serde_json::Value = serde_json::from_slice(&payload).expect("hello payload");
        (client, hello)
    }

    fn send_frame(&mut self, header: &serde_json::Value, payload: &serde_json::Value) {
        let frame = pa_daemon::framing::encode_private_frame(
            header,
            &serde_json::to_vec(payload).expect("payload"),
            pa_daemon::framing::DEFAULT_PRIVATE_FRAME_LIMITS,
        )
        .expect("encode frame");
        self.stream.write_all(&frame).expect("write frame");
        self.stream.flush().expect("flush");
    }

    fn read_frame(&mut self) -> (serde_json::Value, Vec<u8>) {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut prefix = [0u8; 8];
        read_exact_timeout(&mut self.stream, &mut prefix, deadline);
        let header_len = u32::from_be_bytes(prefix[0..4].try_into().unwrap()) as usize;
        let payload_len = u32::from_be_bytes(prefix[4..8].try_into().unwrap()) as usize;
        let mut header = vec![0u8; header_len];
        read_exact_timeout(&mut self.stream, &mut header, deadline);
        let mut payload = vec![0u8; payload_len];
        read_exact_timeout(&mut self.stream, &mut payload, deadline);
        let header: serde_json::Value = serde_json::from_slice(&header).expect("frame header");
        (header, payload)
    }

    fn request(&mut self, command_type: &str, payload: &serde_json::Value) -> serde_json::Value {
        static NEXT_REQUEST: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let request_id = format!(
            "req-{}",
            NEXT_REQUEST.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        );
        self.send_frame(
            &serde_json::json!({
                "kind": "command",
                "requestId": request_id,
                "commandType": command_type,
            }),
            payload,
        );
        loop {
            let (header, body) = self.read_frame();
            if header["outboundType"].as_str() == Some("response")
                && header["requestId"].as_str() == Some(request_id.as_str())
            {
                let mut value: serde_json::Value =
                    serde_json::from_slice(&body).expect("response body");
                value["id"] = serde_json::json!(request_id);
                return value;
            }
        }
    }
}

fn read_exact_timeout(stream: &mut UnixStream, buffer: &mut [u8], deadline: Instant) {
    use std::io::Read;
    let mut read = 0usize;
    while read < buffer.len() {
        assert!(Instant::now() < deadline, "worker frame read timed out");
        match stream.read(&mut buffer[read..]) {
            Ok(0) => panic!("worker closed the connection mid-frame"),
            Ok(n) => read += n,
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut => {}
            Err(error) => panic!("worker read: {error}"),
        }
    }
}

/// The tree commands over the DIRECT worker link (the interactive client's
/// upgraded transport): the peer gate admits them and the branch moves are
/// observable through the store.
#[test]
fn session_tree_commands_over_the_direct_worker_link() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, _hello) = Client::connect(&socket);

    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        serde_json::json!({ "responses": [
            { "text": "first answer", "delayMs": 10 },
            { "text": "second answer", "delayMs": 10 },
        ] })
        .to_string(),
    )
    .expect("write script");
    client.send_command(
        "c1",
        serde_json::json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": session_dir.to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();
    scripted_turn(&mut client, &session_id, "first question", "p1");
    scripted_turn(&mut client, &session_id, "second question", "p2");

    // The supervisor-issued direct-transport ticket + worker peer auth.
    client.send_command(
        "tk1",
        serde_json::json!({
            "type": "get_direct_worker_transport",
            "activeSessionId": session_id,
        }),
    );
    let ticket = client.read_response("tk1");
    assert_eq!(ticket["success"], true, "ticket failed: {ticket}");
    let worker_socket = ticket["data"]["socketPath"].as_str().expect("socket path");
    let (mut worker, _worker_hello) = WorkerClient::connect(std::path::Path::new(worker_socket));
    let grant_id = ticket["data"]["grantId"].as_str().expect("grant id");
    let token = ticket["data"]["token"].as_str().expect("token");
    let instance = ticket["data"]["workerInstanceId"]
        .as_str()
        .expect("instance");
    let auth = worker.request(
        "peer_auth",
        &serde_json::json!({
            "type": "peer_auth",
            "grantId": grant_id,
            "token": token,
            "workerInstanceId": instance,
            "purpose": "session_client",
        }),
    );
    assert_eq!(auth["success"], true, "peer auth failed: {auth}");

    // The tree read over the direct link.
    let tree = worker.request(
        "get_session_tree",
        &serde_json::json!({ "type": "get_session_tree", "activeSessionId": session_id }),
    );
    assert_eq!(
        tree["success"], true,
        "direct get_session_tree failed: {tree}"
    );
    let flat = tree["data"]["flatNodes"].as_array().expect("flatNodes");
    let entry_of = |content: &str, role: &str| {
        flat.iter()
            .find(|node| {
                node["entry"]["type"] == "message"
                    && node["entry"]["message"]["role"] == role
                    && node["entry"]["message"]["content"].as_str() == Some(content)
            })
            .map_or_else(
                || panic!("the {role} entry for {content}"),
                |node| node["entry"]["id"].as_str().expect("id").to_string(),
            )
    };
    let first_assistant_id = entry_of("first answer", "assistant");
    let second_user_id = entry_of("second question", "user");

    // The navigation over the direct link (the timed-out TUI path).
    let navigated = worker.request(
        "navigate_tree",
        &serde_json::json!({
            "type": "navigate_tree",
            "activeSessionId": session_id,
            "targetId": first_assistant_id,
        }),
    );
    assert_eq!(
        navigated["success"], true,
        "direct navigate_tree failed: {navigated}"
    );
    assert_eq!(navigated["data"]["cancelled"], serde_json::json!(false));

    // The fork over the direct link: `before` cuts ahead of the second
    // user message (its text returns as selectedText).
    let forked_before = worker.request(
        "fork",
        &serde_json::json!({
            "type": "fork",
            "activeSessionId": session_id,
            "entryId": second_user_id,
        }),
    );
    assert_eq!(
        forked_before["success"], true,
        "direct fork (before) failed: {forked_before}"
    );
    assert_eq!(
        forked_before["data"]["selectedText"],
        serde_json::json!("second question")
    );
}
