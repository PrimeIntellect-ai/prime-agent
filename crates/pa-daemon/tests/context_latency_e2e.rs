//! Latency regression guard for the operator's `/context` timeout class
//! ("timed out after 10000ms waiting for the Prime Agent daemon response",
//! 2026-09-24): `get_context_tree` must answer from memory — the root
//! usage from the in-memory store, the children from the background cache
//! (`pa-daemon/src/context_tree_cache.rs`) — never by walking the session
//! artifact tree inline.
//!
//! The fixture mirrors the grown fleet store the operator hit: a session
//! with real entries plus a seeded artifact tree of `sub-*` child dirs,
//! each carrying a multi-megabyte child session file. Before the cache,
//! every `get_context_tree` re-read and re-parsed the whole tree inline
//! (measured live on the devbox: 14-19s per call, a 66-persisted-children
//! store over 553MB; `get_session_stats` over the same in-memory store
//! answered in 0.1s). The guard: every `get_context_tree` round trip
//! stays under the sub-second ceiling, and the seeded persisted children
//! DO appear (the cache's background refresh fills them), so the fix can
//! never quietly degrade into an empty-but-fast tree either.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// The generous-but-bounded response ceiling: `/context` is in-memory
/// data (the artifact walk is a background refresh), so a healthy
/// round trip is milliseconds — one full second is the regression
/// ceiling, an order of magnitude under the operator's 10s client
/// timeout.
const CONTEXT_RESPONSE_CEILING: Duration = Duration::from_millis(1_000);

/// How long the test waits for the background refresh to fill the cache
/// with the seeded persisted children (the warm fires at create/attach;
/// the walk is a bounded disk read of the seeded tree).
const CACHE_FILL_DEADLINE: Duration = Duration::from_secs(30);

/// The seeded tree: enough child session bytes (~100MB) that an inline
/// walk would blow the ceiling (the pre-cache code parsed every child
/// file per request), while the seeded write stays a bounded test-setup
/// cost.
const SEEDED_CHILDREN: usize = 60;
const SEEDED_MESSAGES_PER_CHILD: usize = 800;

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

    /// One command round trip with its elapsed wall time. Non-response
    /// frames (events, progress) flow on the same stream and are skipped.
    fn read_response(&mut self, id: &str) -> (Duration, serde_json::Value) {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            assert!(Instant::now() < deadline, "no response for {id} arrived");
            let started = Instant::now();
            let line = self.read_line();
            if line["type"] == "response" && line["id"] == id {
                return (started.elapsed(), line);
            }
        }
    }
}

/// One scripted turn: prompt then drain the turn's stream events until the
/// turn-done boundary (the same contract `session_tree_e2e` uses).
fn scripted_turn(client: &mut Client, session_id: &str, text: &str, id: &str) {
    client.send_command(
        id,
        serde_json::json!({ "type": "prompt", "activeSessionId": session_id, "message": text }),
    );
    let response = client.read_response(id);
    assert_eq!(
        response.1["success"], true,
        "prompt {id} failed: {}",
        response.1
    );
}

/// Seed one persisted child session file: a version-3 session header plus
/// a parent-chained message run with usage records, sized in the
/// megabytes so an inline walk pays a real parse cost per child.
fn seed_child_session(dir: &std::path::Path, child_id: &str) {
    std::fs::create_dir_all(dir).expect("child dir");
    let file = dir.join(format!("{child_id}.jsonl"));
    let filler = "x".repeat(2 * 1024);
    let mut content = String::with_capacity(SEEDED_MESSAGES_PER_CHILD * (filler.len() + 256) + 512);
    content.push_str(
        &serde_json::json!({
            "type": "session", "version": 3, "id": child_id,
            "timestamp": "2024-01-01T00:00:00.000Z", "cwd": "/tmp",
        })
        .to_string(),
    );
    content.push('\n');
    let mut parent_id: Option<String> = None;
    for index in 0..SEEDED_MESSAGES_PER_CHILD {
        let entry_id = format!("{child_id}-m{index}");
        content.push_str(&serde_json::json!({
            "type": "message",
            "id": entry_id,
            "parentId": parent_id,
            "timestamp": "2024-01-01T00:00:00.000Z",
            "message": {
                "role": if index % 2 == 0 { "user" } else { "assistant" },
                "content": if index % 2 == 0 { "seed question" } else { &filler },
                "usage": if index % 2 == 1 {
                    serde_json::json!({
                        "input": 1000, "output": 100, "cacheRead": 0, "cacheWrite": 0,
                        "totalTokens": 1100,
                        "cost": { "input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0, "total": 2 },
                    })
                } else { serde_json::Value::Null },
            },
        }).to_string());
        content.push('\n');
        parent_id = Some(entry_id);
    }
    std::fs::write(&file, content).expect("write seeded child session");
}

#[test]
fn get_context_tree_answers_from_memory_on_a_grown_store() {
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
    let (_, created) = client.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let active_session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["activeSessionId"].as_str())
        .expect("active session id")
        .to_string();
    let durable_session_id = created["data"]["sessionId"]
        .as_str()
        .expect("durable session id")
        .to_string();

    // Real entries in the worker's own store.
    scripted_turn(&mut client, &active_session_id, "first question", "p1");
    scripted_turn(&mut client, &active_session_id, "second question", "p2");

    // The grown artifact tree: the durable id's `sub-*` children, each a
    // multi-megabyte session file (the walk's per-child parse cost).
    let artifacts_root = agent_dir
        .join("session-artifacts")
        .join(&durable_session_id);
    for index in 0..SEEDED_CHILDREN {
        let child_dir = artifacts_root.join(format!("sub-latency-{index:03}"));
        seed_child_session(&child_dir, &format!("latency-child-{index:03}"));
    }
    let seeded_bytes: u64 = (0..SEEDED_CHILDREN)
        .map(|index| {
            std::fs::metadata(
                artifacts_root
                    .join(format!("sub-latency-{index:03}"))
                    .join(format!("latency-child-{index:03}.jsonl")),
            )
            .expect("seeded file")
            .len()
        })
        .sum();

    // The attach warms the cache (the background walk fires here), like
    // the operator's chat surface attaching at open.
    client.send_command(
        "a1",
        serde_json::json!({
            "type": "attach",
            "activeSessionId": active_session_id,
            "clientId": "latency-guard",
        }),
    );
    let (_, attached) = client.read_response("a1");
    assert_eq!(attached["success"], true, "attach failed: {attached}");

    // Every read must answer under the ceiling, cold or warm: the root is
    // in-memory data and the children come from the cache (a cold cache
    // serves the live rows alone; the background refresh fills the
    // persisted tree for the next read).
    let mut saw_seeded_children = false;
    let deadline = Instant::now() + CACHE_FILL_DEADLINE;
    let mut reads = 0;
    while Instant::now() < deadline {
        reads += 1;
        let id = format!("ctx{reads}");
        client.send_command(
            &id,
            serde_json::json!({
                "type": "get_context_tree",
                "activeSessionId": active_session_id,
            }),
        );
        let (elapsed, tree) = client.read_response(&id);
        assert_eq!(tree["success"], true, "get_context_tree failed: {tree}");
        let children = tree["data"]["children"].as_array().expect("children");
        eprintln!(
            "context-latency guard: read #{reads} took {elapsed:?} ({} children), \
             seeded tree {seeded_bytes} bytes",
            children.len()
        );
        assert!(
            elapsed <= CONTEXT_RESPONSE_CEILING,
            "get_context_tree read #{reads} took {elapsed:?} (ceiling {CONTEXT_RESPONSE_CEILING:?}) — \
             the inline artifact walk is back (the operator's 10s /context timeout class); \
             seeded tree: {seeded_bytes} bytes",
        );
        if children.len() >= SEEDED_CHILDREN {
            // The persisted rows carry the seeded files' real usage (the
            // background walk parsed them, not the request path).
            let with_usage = children
                .iter()
                .filter(|node| node["totalUsage"]["input"].as_u64().unwrap_or(0) > 0)
                .count();
            assert_eq!(
                with_usage, SEEDED_CHILDREN,
                "persisted children must carry the seeded usage"
            );
            saw_seeded_children = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(
        saw_seeded_children,
        "the background refresh never filled the cache with the seeded children \
         (expected {SEEDED_CHILDREN} within {CACHE_FILL_DEADLINE:?})"
    );
}
