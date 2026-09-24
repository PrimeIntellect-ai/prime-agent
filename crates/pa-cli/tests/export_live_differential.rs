//! Differential parity for the live-session HTML export: the same fixture
//! session (a custom-tool call that no renderer covers) resumed and
//! exported through the TS daemon and the Rust daemon produces the same
//! export data — the tools section (TS `state.tools` embedded
//! name/description/parameters), the entries, the header, and the
//! pre-render section's omission. `systemPrompt` presence is compared,
//! not content: the layered prompt supersedes TS-prompt byte parity.
//!
//! Both sides run the export where the product runs it: the daemon
//! worker's `export_html` wire command (TS `session.exportToHtml` with
//! the tool renderer; the Rust worker's `ExportCommands`). The TS daemon
//! is ground truth; the test skips when the TS binary is not installed.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// Environment identity that would leak an ambient daemon/worker/session
/// into the spawned supervisors or change model resolution.
const SCRUB_ENV: &[&str] = &[
    "PRIME_AGENT_INTERNAL_DAEMON_WORKER",
    "PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN",
    "PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID",
    "PRIME_AGENT_INTERNAL_DAEMON_WORKER_INSTANCE_ID",
    "PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL",
    "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET",
    "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL",
    "PRIME_AGENT_INTERNAL_SESSION_LEASES",
    "PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID",
    "PRIME_TEAM_ID",
];

fn ts_binary() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("PA_TS_BINARY") {
        let path = PathBuf::from(path);
        return path.exists().then_some(path);
    }
    Command::new("prime-agent")
        .arg("--version")
        .output()
        .ok()?
        .status
        .success()
        .then(|| PathBuf::from("prime-agent"))
}

struct Supervisor {
    child: Child,
    socket: PathBuf,
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        graceful_shutdown(&self.socket);
        let workers = child_pids_of(self.child.id());
        let _ = self.child.kill();
        let _ = self.child.wait();
        for pid in workers {
            kill_worker(&pid);
        }
        let _ = std::fs::remove_file(&self.socket);
    }
}

fn kill_worker(pid: &u32) {
    unsafe {
        libc::kill(*pid as i32, libc::SIGKILL);
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while process_alive(*pid) {
        assert!(
            Instant::now() < deadline,
            "worker {pid} survived the teardown kill"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn process_alive(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .map(|stat| {
            let rest = stat
                .rsplit_once(')')
                .map(|(_, rest)| rest)
                .unwrap_or_default();
            !rest.starts_with('Z')
        })
        .unwrap_or(false)
}

fn child_pids_of(ppid: u32) -> Vec<u32> {
    let mut pids = Vec::new();
    let entries = std::fs::read_dir("/proc").expect("read /proc");
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        let Some((_, rest)) = stat.rsplit_once(')') else {
            continue;
        };
        let mut fields = rest.split_whitespace();
        fields.next(); // process state
        let Ok(parent) = fields.next().unwrap_or_default().parse::<u32>() else {
            continue;
        };
        if parent == ppid {
            pids.push(pid);
        }
    }
    pids
}

fn graceful_shutdown(socket: &Path) {
    let Ok(stream) = UnixStream::connect(socket) else {
        return;
    };
    let Ok(write_half) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(stream);
    let mut writer = write_half;
    let mut hello = String::new();
    let _ = reader.read_line(&mut hello); // daemon_hello
    let command = json!({
        "type": "command",
        "id": "test-shutdown",
        "protocol": { "name": "prime-agent.daemon", "version": 7 },
        "command": { "type": "shutdown" },
    });
    let mut line = serde_json::to_string(&command).expect("serialize");
    line.push('\n');
    if writer.write_all(line.as_bytes()).is_err() {
        return;
    }
    let _ = writer.flush();
    let _ = reader
        .get_ref()
        .set_read_timeout(Some(Duration::from_secs(5)));
    let mut response = String::new();
    let _ = reader.read_line(&mut response);
}

#[allow(clippy::zombie_processes)]
fn spawn_supervisor(binary: &Path, dir: &Path) -> Supervisor {
    let socket = dir.join("daemon.sock");
    let agent_dir = dir.join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let mut command = Command::new(binary);
    command
        .args(["--mode", "daemon", "--daemon-socket"])
        .arg(&socket)
        .env("PRIME_AGENT_CODING_AGENT_DIR", &agent_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for var in SCRUB_ENV {
        command.env_remove(var);
    }
    for provider in pa_ai::models_generated::get_providers() {
        if let Some(vars) = pa_ai::env_api_keys::get_api_key_env_vars(provider) {
            for var in vars {
                command.env_remove(var);
            }
        }
    }
    // A killed supervisor reaps its workers on the same short orphan-exit
    // window as the TS daemon.
    command.env(
        pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
        "15000",
    );
    let child = command.spawn().expect("spawn daemon supervisor");
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if socket.exists() {
            return Supervisor { child, socket };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("supervisor socket never appeared");
}

/// The daemon wire client: one line in, one matching response line out
/// (events skip past until the response with our id arrives).
struct Wire {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Wire {
    fn connect(socket: &Path) -> Self {
        let stream = UnixStream::connect(socket).expect("connect supervisor");
        let writer = stream.try_clone().expect("clone stream");
        let mut reader = BufReader::new(stream);
        let mut hello = String::new();
        reader.read_line(&mut hello).expect("daemon hello");
        assert!(hello.contains("daemon_hello"), "hello: {hello}");
        Wire { reader, writer }
    }

    fn request(&mut self, command: Value) -> Value {
        let id = command
            .get("id")
            .and_then(Value::as_str)
            .expect("command id")
            .to_string();
        let envelope = json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        });
        let mut line = serde_json::to_string(&envelope).expect("serialize");
        line.push('\n');
        self.writer.write_all(line.as_bytes()).expect("write");
        self.writer.flush().expect("flush");
        self.reader
            .get_ref()
            .set_read_timeout(Some(Duration::from_mins(2)))
            .expect("read timeout");
        loop {
            let mut response = String::new();
            self.reader.read_line(&mut response).expect("read line");
            let value: Value = serde_json::from_str(&response).expect("wire json");
            if value.get("type") == Some(&json!("response")) && value.get("id") == Some(&json!(id))
            {
                return value;
            }
        }
    }
}

/// The fixture session: a custom-tool call (`my_tool`) plus its result —
/// no renderer covers it in either product, so both exports must treat it
/// through the template's generic fallback with the `renderedTools`
/// section omitted. The TS wire usage shape (`input`/`output`/`cost`) is
/// required: the daemon computes usage summaries at create.
fn write_fixture(path: &Path, cwd: &Path) -> Vec<Value> {
    let usage = json!({
        "input": 10, "output": 5, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 15,
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 },
    });
    let entries = vec![
        json!({
            "type": "model_change", "provider": "faux", "modelId": "faux-1",
            "id": "e0", "parentId": null, "timestamp": "2026-09-01T10:00:00.500Z",
        }),
        json!({
            "type": "message", "id": "e1", "parentId": "e0",
            "timestamp": "2026-09-01T10:00:01.000Z",
            "message": { "role": "user", "content": "export a fixture" },
        }),
        json!({
            "type": "message", "id": "e2", "parentId": "e1",
            "timestamp": "2026-09-01T10:00:02.000Z",
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": "the answer" }],
                "usage": usage,
                "stopReason": "stop",
            },
        }),
        json!({
            "type": "message", "id": "e3", "parentId": "e2",
            "timestamp": "2026-09-01T10:00:03.000Z",
            "message": {
                "role": "assistant",
                "content": [{ "type": "toolCall", "id": "tc1", "name": "my_tool",
                              "arguments": { "query": "hello" } }],
                "usage": usage,
                "stopReason": "toolUse",
            },
        }),
        json!({
            "type": "message", "id": "e4", "parentId": "e3",
            "timestamp": "2026-09-01T10:00:04.000Z",
            "message": {
                "role": "toolResult", "toolCallId": "tc1", "toolName": "my_tool",
                "content": [{ "type": "text", "text": "tool output line" }],
                "isError": false,
            },
        }),
    ];
    let header = json!({
        "type": "session", "id": "export-differential", "version": 3,
        "timestamp": "2026-09-01T10:00:00.000Z",
        "cwd": cwd.to_string_lossy(),
    });
    let lines = std::iter::once(header)
        .chain(entries.iter().cloned())
        .map(|line| serde_json::to_string(&line).expect("serialize entry"))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(path, format!("{lines}\n")).expect("write fixture");
    entries
}

/// The base64-embedded session data of an exported file, decoded.
fn exported_session_data(html: &str) -> Value {
    use base64::Engine as _;
    let marker = "session-data\" type=\"application/json\">";
    let start = html.find(marker).expect("session data element");
    let blob = &html[start + marker.len()..];
    let blob = blob.split('<').next().expect("script close");
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(blob.trim())
        .expect("base64 session data");
    serde_json::from_slice(&decoded).expect("session data JSON")
}

/// One side's live export: spawn the daemon, resume the fixture, export.
fn live_export(binary: &Path, base: &Path, ts_side: bool) -> Value {
    let work = base.join("work");
    std::fs::create_dir_all(&work).expect("work dir");
    let supervisor = spawn_supervisor(binary, base);
    let session_dir = base.join("agent").join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let fixture = base.join("fixture.jsonl");
    let expected_entries = write_fixture(&fixture, &work);
    let mut wire = Wire::connect(&supervisor.socket);
    // TS resolves its faux provider explicitly; the Rust worker drives
    // the same real engine through the `engine: "faux"` script seam.
    let config = if ts_side {
        json!({
            "cwd": work.to_string_lossy(),
            "sessionDir": session_dir.to_string_lossy(),
            "provider": "faux",
            "model": "faux-1",
        })
    } else {
        let script = base.join("script.json");
        std::fs::write(
            &script,
            json!({ "engine": "faux", "responses": [] }).to_string(),
        )
        .expect("write script");
        json!({
            "cwd": work.to_string_lossy(),
            "sessionDir": session_dir.to_string_lossy(),
            "script": script.to_string_lossy(),
        })
    };
    let create = wire.request(json!({
        "id": "c1", "type": "create",
        "sessionPath": fixture.to_string_lossy(),
        "name": "export-diff",
        "config": config,
    }));
    assert_eq!(create["success"], true, "create failed: {create}");
    let session_id = create["data"]["activeSessionId"]
        .as_str()
        .or_else(|| create["data"]["id"].as_str())
        .expect("session id")
        .to_string();
    let out = base.join("out.html");
    let export = wire.request(json!({
        "id": "x1", "type": "export_html",
        "activeSessionId": session_id,
        "outputPath": out.to_string_lossy(),
    }));
    assert_eq!(export["success"], true, "export failed: {export}");
    assert_eq!(
        export["data"]["path"].as_str().map(Path::new),
        Some(out.as_path()),
        "export path: {export}"
    );
    let html = std::fs::read_to_string(&out).expect("exported html");
    let mut data = exported_session_data(&html);
    let expected = serde_json::to_value(&expected_entries).expect("entries value");
    data["expectedEntries"] = expected;
    data
}

/// Differential: the live-session export of the same fixture through the
/// TS daemon (ground truth) and the Rust daemon carries the same tools
/// section, the same fixture entries, the same header, and the same
/// omitted pre-render — the custom-tool call renders through the
/// template's generic fallback in both.
#[test]
fn differential_live_export_matches_ts_binary() {
    let Some(ts) = ts_binary() else {
        eprintln!("SKIPPED: TS prime-agent binary not found (set PA_TS_BINARY)");
        return;
    };
    let rust = PathBuf::from(env!("CARGO_BIN_EXE_prime-agent"));
    let ts_base = tempfile::TempDir::new().expect("temp dir");
    let rs_base = tempfile::TempDir::new().expect("temp dir");
    let ts_data = live_export(&ts, ts_base.path(), true);
    let rs_data = live_export(&rust, rs_base.path(), false);

    // Header: identical except the sandbox-specific cwd.
    let normalize = |value: &Value, base: &Path| {
        serde_json::to_string(value)
            .expect("serialize")
            .replace(base.to_string_lossy().as_ref(), "<sandbox>")
            .parse::<Value>()
            .expect("re-parse")
    };
    let ts_header = normalize(&ts_data["header"], ts_base.path());
    let rs_header = normalize(&rs_data["header"], rs_base.path());
    assert_eq!(ts_header, rs_header, "session header");

    // The fixture's entries survive the resume identically on both sides
    // (both daemons may append a creation prefix after them).
    let assert_prefix = |data: &Value, label: &str| {
        let entries = data["entries"].as_array().expect("entries");
        let expected = data["expectedEntries"].as_array().expect("expected");
        assert!(
            entries.len() >= expected.len(),
            "{label}: entries truncated: {entries:?}"
        );
        for (index, (actual, want)) in entries.iter().zip(expected).enumerate() {
            assert_eq!(actual, want, "{label} entry {index}");
        }
    };
    assert_prefix(&ts_data, "ts");
    assert_prefix(&rs_data, "rust");

    // The tools section: the session's registered tool contract, equal in
    // both products (TS `state.tools` vs the Rust engine registry).
    assert_eq!(ts_data["tools"], rs_data["tools"], "tools section");
    let ipython_registered = ts_data["tools"]
        .as_array()
        .expect("tools array")
        .iter()
        .any(|tool| {
            tool["name"] == "ipython"
                && tool["description"].is_string()
                && tool["parameters"].is_object()
        });
    assert!(
        ipython_registered,
        "ipython contract in tools: {}",
        ts_data["tools"]
    );

    // The custom-tool call has no renderer in either product: the section
    // is omitted (not null), so the template's generic fallback applies
    // identically in both.
    assert!(
        ts_data.get("renderedTools").is_none(),
        "TS renderedTools omitted: {}",
        ts_data["renderedTools"]
    );
    assert!(
        rs_data.get("renderedTools").is_none(),
        "Rust renderedTools omitted: {}",
        rs_data["renderedTools"]
    );

    // The system prompt section exists in both (content parity is
    // superseded by the layered prompt design).
    assert!(ts_data["systemPrompt"].is_string(), "TS system prompt");
    assert!(rs_data["systemPrompt"].is_string(), "Rust system prompt");
}
