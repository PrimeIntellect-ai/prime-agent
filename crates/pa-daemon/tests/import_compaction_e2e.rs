//! End-to-end verifier for the imported-session compaction view (the
//! `import_jsonl` compact gap found by the perf wave, PR #272): a session
//! grown through `import_jsonl` must compact on the next `compact` — TS is
//! one-store, so the imported rows land in the same session manager the
//! compaction walks.
//!
//! Root cause (verified against the TS binary with the perf-wave fixture
//! shape): the Rust session-file parse degraded whole message rows to
//! `Unknown` on fields the TS loader tolerates — an assistant row with the
//! raw provider `stopReason: "tool_calls"`, a tool result without
//! `toolName` — so the imported transcript silently lost two of every
//! three rows. The provider request still carried the surviving rows (the
//! perf wave's "rows reach the provider context"), but the compaction walk
//! under-counted: no cut point with history before the default 20k-token
//! keep window, so `compact` answered "Session is too short to compact"
//! while the TS daemon compacted the same import. The pa-types wire parse
//! keeps those rows (the `tool_calls` stop-reason alias, the defaulted
//! `toolName`); this test locks the whole flow: the rows persist, the walk
//! finds the cut inside the imported transcript, the compact runs, and the
//! durable compaction row records the same cut (one-store id parity).
//!
//! Regression scope: the #259 import wire e2es (`protocol_breadth_b6_b9`
//! wave b9) and the #243 recovery walk (`goal_recovery_e2e`) stay green in
//! the same suites.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
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

/// One client connection: request/response plus every session event that
/// streamed while the response was outstanding.
struct Client {
    reader: BufReader<std::os::unix::net::UnixStream>,
    writer: std::os::unix::net::UnixStream,
}

impl Client {
    fn connect(socket: &Path) -> Client {
        let stream = std::os::unix::net::UnixStream::connect(socket).expect("connect");
        let writer = stream.try_clone().expect("clone");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer,
        };
        let hello = client.read_line();
        assert_eq!(hello["type"], "daemon_hello");
        client
    }

    fn read_line(&mut self) -> Value {
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_secs(300);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("timeout");
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => continue,
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

    /// The response for `id`, skipping every session event on the way.
    fn request(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(300);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }
}

/// The harness: a supervisor, a faux-scripted session over the real agent
/// engine (compaction enabled with a tiny keep window so a manual compact
/// cuts), and the session dir the durable rows land in.
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
    // Default compaction settings (keepRecentTokens 20000), like the perf
    // wave's repro: the fixture must be big enough that the walk finds a
    // cut with history to summarize — the default keep window is part of
    // what the gap hid behind.
    let responses: Vec<Value> = (0..8)
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
    Harness {
        dir,
        _supervisor: supervisor,
        client,
        session_id,
    }
}

/// The grown import fixture (the perf-wave scale-corpus shape, PR #272):
/// a parent-chained transcript whose turns are a user message, an
/// assistant message with thinking/text content blocks and a top-level
/// `toolCalls` array, and a tool result — the row mix the perf wave
/// imported when it found the compact gap. The assistant rows carry the
/// raw provider `stopReason: "tool_calls"` and the tool results carry no
/// `toolName`: both are shapes the TS loader keeps (its `buildSessionContext`
/// pushes the raw rows), so the Rust session-file parse must keep them too
/// or the imported transcript silently loses two of every three rows —
/// the compaction walk then under-counts, finds no cut with history, and
/// answers "Session is too short to compact" while the provider request
/// still carries the surviving rows.
fn grown_fixture(dir: &Path, turns: usize) -> PathBuf {
    let fixture = dir.join("grown-import.jsonl");
    let mut lines = vec![json!({
        "type": "session",
        "id": "grown-import",
        "version": 3,
        "timestamp": "2026-01-01T00:00:00.000Z",
        "cwd": dir.to_string_lossy(),
        "rlmDepth": 0,
    })
    .to_string()];
    let mut parent: Option<String> = None;
    for turn in 0..turns {
        for (kind, id) in [
            ("user", format!("u{turn}")),
            ("assistant", format!("a{turn}")),
            ("tool_result", format!("t{turn}")),
        ] {
            let message = match kind {
                "user" => json!({
                    "role": "user",
                    "content": [{ "type": "text", "text": format!("please do task number {turn}") }],
                    "timestamp": 1_789_976_028_471i64 + turn as i64,
                }),
                "assistant" => json!({
                    "role": "assistant",
                    "content": [
                        { "type": "thinking", "thinking": format!("task {turn}: run the corpus command") },
                        { "type": "text", "text": format!("Running the tool for task {turn}.") },
                    ],
                    "toolCalls": [{
                        "id": format!("call-{turn}"),
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
                    "timestamp": 1_789_976_028_471i64 + turn as i64,
                }),
                _ => json!({
                    "role": "toolResult",
                    "toolCallId": format!("call-{turn}"),
                    "content": [{ "type": "text", "text": format!("corpus {turn}\n[0, 1, 2]\n") }],
                    "isError": false,
                    "timestamp": 1_789_976_028_471i64 + turn as i64,
                }),
            };
            let entry = json!({
                "type": "message",
                "id": id,
                "parentId": parent,
                "timestamp": "2026-01-01T00:00:01.000Z",
                "message": message,
            });
            parent = Some(id.clone());
            lines.push(entry.to_string());
        }
    }
    std::fs::write(&fixture, lines.join("\n") + "\n").expect("write fixture");
    fixture
}

/// The durable session rows of `type`, re-read from the session dir's
/// imported copy.
fn session_rows(harness: &Harness, type_: &str) -> Vec<Value> {
    let session_dir = harness.dir.path().join("agent").join("sessions");
    let file = std::fs::read_dir(&session_dir)
        .expect("session dir readable")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("grown-import"))
        })
        .expect("the imported session's copy in the session dir");
    std::fs::read_to_string(file)
        .expect("session file readable")
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .filter(|entry| entry.get("type").and_then(Value::as_str) == Some(type_))
        .collect()
}

/// The compact runs on the imported session: the imported rows seed the
/// engine's compaction view (TS one-store parity — `importFromJsonl` lands
/// in the same session manager the compaction walks), so `compact` runs
/// and produces the durable summary row instead of refusing with
/// "Session is too short to compact".
#[test]
fn imported_session_compacts() {
    let mut harness = setup("import-compact");
    // Big enough that the default 20k-token keep window still leaves
    // history before the cut (the perf-wave corpus: 1500 turns).
    let fixture = grown_fixture(harness.dir.path(), 1200);

    // Import the grown transcript onto the live session.
    harness.client.send_command(
        "i-1",
        json!({
            "type": "import_jsonl",
            "activeSessionId": harness.session_id,
            "inputPath": fixture.to_string_lossy(),
            "cwdOverride": harness.dir.path().to_string_lossy(),
        }),
    );
    let imported = harness.client.request("i-1");
    assert_eq!(imported["success"], true, "import failed: {imported}");
    assert_eq!(imported["data"], json!({ "cancelled": false }));

    // The imported transcript is the session the compact walks: every
    // row the TS loader keeps must persist, the assistant and tool-result
    // rows included (a lossy parse drops two of every three rows here).
    let rows = session_rows(&harness, "message");
    assert_eq!(rows.len(), 3600, "the imported rows persist: {rows:?}");
    assert!(
        rows.iter().any(|row| row["message"]["role"] == "assistant"
            && row["message"]["stopReason"] == "tool_calls"),
        "the foreign-shape assistant rows survive the import: {rows:?}"
    );
    assert!(
        rows.iter().any(|row| row["message"]["role"] == "toolResult"
            && row["message"].get("toolName").is_none()),
        "the tool results without toolName survive the import: {rows:?}"
    );

    // A turn on the imported session (the perf-wave repro: the provider
    // request after the import carries the imported rows).
    harness.client.send_command(
        "p-1",
        json!({
            "type": "prompt_and_wait",
            "activeSessionId": harness.session_id,
            "message": "one turn on the imported session",
        }),
    );
    let turned = harness.client.request("p-1");
    assert_eq!(turned["success"], true, "prompt failed: {turned}");

    // Compact: must run (TS parity), not refuse as too short.
    harness.client.send_command(
        "cp-1",
        json!({ "type": "compact", "activeSessionId": harness.session_id }),
    );
    let compact = harness.client.request("cp-1");
    assert_eq!(
        compact["success"], true,
        "the imported session must compact: {compact}"
    );
    assert!(
        compact["data"]["summary"].is_string(),
        "the compact answers the TS result shape: {compact}"
    );
    // The cut must sit INSIDE the imported transcript (a walk that lost the
    // imported rows has no history to summarize and refuses as too short).
    // The cut may split a turn (an assistant row is a valid cut point when
    // its trailing tool result stays kept), so any fixture row id past the
    // first turn proves the walk traversed the imported rows.
    let first_kept = compact["data"]["firstKeptEntryId"]
        .as_str()
        .unwrap_or_default();
    let kept_turn: Option<u32> = first_kept
        .strip_prefix(|c: char| c == 'u' || c == 'a' || c == 't')
        .and_then(|index| index.parse().ok());
    assert!(
        kept_turn.is_some_and(|turn| turn > 0),
        "the cut keeps the recent tail of the imported transcript: {compact}"
    );

    // The compaction landed durably on the imported session's file.
    let compactions = session_rows(&harness, "compaction");
    assert_eq!(
        compactions.len(),
        1,
        "the durable compaction row: {compactions:?}"
    );
    assert_eq!(
        compactions[0]["firstKeptEntryId"].as_str(),
        Some(first_kept),
        "the durable row records the same cut: {compactions:?}"
    );
}
