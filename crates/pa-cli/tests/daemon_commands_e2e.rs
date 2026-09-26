//! End-to-end daemon-command tests: spawn the real `pa-daemon` supervisor on a
//! temp socket, drive `prime-agent` list/stop/rename against it, and diff the
//! output against goldens captured from the installed TS `prime-agent` binary
//! (v0.9.5). A second test spawns the TS daemon itself and runs both CLIs
//! against it, asserting identical output for the commands both CLIs share
//! (send and schedule parity is exercised there because the Rust supervisor
//! does not implement those commands yet).
//!
//! Goldens (captured from the live TS binary, protocol 7):
//!
//! ```text
//! $ prime-agent list            # one live session named "research"
//! name      id            status  age  model                         messages  clients
//! research  b72ad7009b11  idle    3s   prime-inference/z-ai/glm-5.3  0         0
//!
//! $ prime-agent list           # no live sessions
//! No active agents.
//!
//! $ prime-agent list --all     # no saved sessions
//! No agents.
//!
//! $ prime-agent stop <id>
//! ok
//!
//! $ prime-agent rename <id> gamma
//! Renamed 0f04b31cb2b6 to gamma
//!
//! $ prime-agent schedule add gamma "every 5 minutes" -- "do the thing"
//! Scheduled 0451e5a9-951c-457b-ae76-ea3142ea5d25 next=2026-09-16T18:36:59.287Z
//!
//! $ prime-agent schedule list
//! 0451e5a9-951c-457b-ae76-ea3142ea5d25 active next=9/16/2026, 6:36:59 PM last=- runs=0 schedule="every 5 minutes" prompt="do the thing"
//! ```
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// Environment keys this box's own prime-agent worker sets; they must not leak
/// into spawned daemons or their session workers. `PI_PACKAGE_DIR` is
/// scrubbed too: it overrides both binaries' package-manifest resolution,
/// and a value pointing at the Rust checkout (where gate runners point it
/// for kernel-runtime resolution) makes the TS CLI read a nonexistent
/// `package.json` and exit before it can serve anything.
const SCRUB_ENV: [&str; 10] = [
    "PRIME_AGENT_INTERNAL_DAEMON_WORKER",
    "PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN",
    "PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID",
    "PRIME_AGENT_INTERNAL_DAEMON_WORKER_INSTANCE_ID",
    "PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL",
    "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET",
    "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL",
    "PRIME_AGENT_INTERNAL_SESSION_LEASES",
    "PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID",
    "PI_PACKAGE_DIR",
];

/// Locate the built `pa-daemon` binary next to this crate's `prime-agent`
/// binary. Cargo builds bins of the crate under test only, so this resolves
/// under the workspace gate (`cargo test --workspace`) and asks for an
/// explicit build otherwise.
fn daemon_binary() -> PathBuf {
    let profile_dir = Path::new(env!("CARGO_BIN_EXE_prime-agent"))
        .parent()
        .expect("profile directory of the prime-agent binary")
        .to_path_buf();
    let daemon = profile_dir.join("pa-daemon");
    assert!(
        daemon.exists(),
        "pa-daemon binary not found at {}; run `cargo build -p pa-daemon` \
         (or the workspace gate `cargo test --workspace`) first",
        daemon.display()
    );
    daemon
}

/// The installed TS binary, when present (`PA_TS_BINARY` or `prime-agent` on PATH).
fn ts_binary() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("PA_TS_BINARY") {
        let path = PathBuf::from(path);
        return path.exists().then_some(path);
    }
    let probe = Command::new("prime-agent")
        .arg("--version")
        .output()
        .ok()?
        .status
        .success()
        .then(|| PathBuf::from("prime-agent"));
    probe
}

struct Daemon {
    child: Child,
    socket: PathBuf,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[allow(clippy::zombie_processes)]
fn spawn_daemon(binary: &Path, socket: &Path, agent_dir: &Path) -> Daemon {
    let mut command = Command::new(binary);
    command
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .env("PRIME_AGENT_CODING_AGENT_DIR", agent_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for key in SCRUB_ENV {
        command.env_remove(key);
    }
    // A supervisor killed at teardown must not leak its session workers
    // into later test binaries: the worker's supervisor-lost exit (TS
    // `exitIfSupervisorOrphanedForTooLong`) runs on this short window
    // instead of the 5-minute default.
    command.env(
        pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
        "15000",
    );
    let child = command.spawn().expect("spawn daemon supervisor");
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

/// A raw JSONL protocol client, mirroring the harness in
/// `crates/pa-daemon/tests/supervisor_e2e.rs`.
struct Wire {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Wire {
    fn connect(socket: &Path) -> (Self, Value) {
        let deadline = Instant::now() + Duration::from_secs(5);
        let stream = loop {
            match UnixStream::connect(socket) {
                Ok(stream) => break stream,
                Err(_) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => panic!("connect daemon: {error}"),
            }
        };
        let writer = stream.try_clone().expect("clone socket");
        let mut wire = Wire {
            reader: BufReader::new(stream),
            writer,
        };
        let hello = wire.read_line();
        (wire, hello)
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
        let deadline = Instant::now() + Duration::from_mins(1);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("daemon closed the connection"),
                Ok(_) if line.trim().is_empty() => {}
                Ok(_) => return serde_json::from_str(line.trim()).expect("parse daemon line"),
                Err(_) if Instant::now() < deadline => {}
                Err(error) => panic!("timed out waiting for daemon line: {error}"),
            }
        }
    }

    fn request(&mut self, id: &str, command: Value) -> Value {
        self.send_command(id, command);
        loop {
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }
}

/// Create one session on the daemon (the scripted engine for the Rust
/// supervisor, a real session worker for the TS one).
fn create_session(
    wire: &mut Wire,
    id: &str,
    name: &str,
    cwd: &Path,
    session_dir: &Path,
    script: Option<&Path>,
) -> String {
    let mut config = json!({
        "cwd": cwd.to_string_lossy(),
        "sessionDir": session_dir.to_string_lossy(),
    });
    if let Some(script) = script {
        config["script"] = json!(script.to_string_lossy());
    }
    let response = wire.request(
        id,
        json!({ "type": "create", "name": name, "config": config }),
    );
    assert_eq!(response["success"], true, "create failed: {response}");
    response["data"]["activeSessionId"]
        .as_str()
        .or_else(|| response["data"]["id"].as_str())
        .expect("active session id")
        .to_string()
}

/// Run a CLI binary in an isolated environment (agent dir + TMPDIR point into
/// the temp dir so the default socket path resolves inside it too).
fn run_cli(binary: &Path, dir: &Path, agent_dir: &Path, args: &[&str]) -> Output {
    let mut command = Command::new(binary);
    command
        .args(args)
        .current_dir(dir)
        .env("PRIME_AGENT_CODING_AGENT_DIR", agent_dir)
        .env("TMPDIR", dir);
    for key in SCRUB_ENV {
        command.env_remove(key);
    }
    command.output().expect("spawn CLI binary")
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// Replace volatile tokens (age buckets, hex ids, uuids, timestamps) so outputs
/// captured at different moments compare equal.
fn normalize(text: &str) -> String {
    text.split('\n')
        .map(|line| {
            line.split_whitespace()
                .map(normalize_token)
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn normalize_token(token: &str) -> String {
    if let Some((key, value)) = token.split_once('=') {
        return format!("{key}={}", normalize_token(value));
    }
    if let Some(stripped) = token.strip_suffix(',') {
        return format!("{},", normalize_token(stripped));
    }
    if is_age(token) || is_clock(token) || token == "AM" || token == "PM" {
        return "<time>".to_string();
    }
    if is_hex_id(token) || is_uuid(token) || is_iso_timestamp(token) || is_local_date(token) {
        return "<timestamp>".to_string();
    }
    token.to_string()
}

fn is_age(token: &str) -> bool {
    let digits = token
        .strip_suffix(['s', 'm', 'h', 'd', 'w', 'y'])
        .unwrap_or("");
    !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())
}

fn is_hex_id(token: &str) -> bool {
    token.len() == 12 && token.chars().all(|c| c.is_ascii_hexdigit())
}

fn is_uuid(token: &str) -> bool {
    token.len() == 36
        && token.split('-').count() == 5
        && token
            .split('-')
            .map(str::len)
            .zip([8, 4, 4, 4, 12])
            .all(|(actual, expected)| actual == expected)
}

fn is_iso_timestamp(token: &str) -> bool {
    token.len() >= 20 && token.starts_with(|c: char| c.is_ascii_digit()) && token.contains('T')
}

fn is_local_date(token: &str) -> bool {
    let Some((month_day_year, _)) = token.split_once('/') else {
        return false;
    };
    month_day_year.chars().all(|c| c.is_ascii_digit())
}

fn is_clock(token: &str) -> bool {
    let parts: Vec<&str> = token.split(':').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
}

/// Recursively sort object keys so TS (insertion order) and Rust (sorted) JSON
/// key orders compare equal.
fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut sorted = serde_json::Map::new();
            for key in keys {
                sorted.insert(key.clone(), canonicalize(&map[key]));
            }
            Value::Object(sorted)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonicalize).collect()),
        other => other.clone(),
    }
}

/// CLI args with the daemon socket flag prepended.
fn list_args<'a>(socket: &'a str, rest: &[&'a str]) -> Vec<&'a str> {
    let mut args: Vec<&'a str> = vec!["--daemon-socket", socket];
    args.extend(rest.iter().copied());
    args
}

/// The two CLIs under comparison and their shared sandbox.
struct CliPair {
    ts: PathBuf,
    rust: PathBuf,
    dir: PathBuf,
    agent_dir: PathBuf,
}

impl CliPair {
    /// Run one command through both CLIs and record any output mismatch.
    fn compare(&self, failures: &mut Vec<String>, ts_args: &[&str], rs_args: &[&str], label: &str) {
        let ts_out = run_cli(&self.ts, &self.dir, &self.agent_dir, ts_args);
        let rs_out = run_cli(&self.rust, &self.dir, &self.agent_dir, rs_args);
        let ok = ts_out.status.code() == rs_out.status.code()
            && normalize(&stdout(&ts_out)) == normalize(&stdout(&rs_out))
            && normalize(&stderr(&ts_out)) == normalize(&stderr(&rs_out));
        if !ok {
            failures.push(format!(
            "{label}:\n  ts exit {:?} stdout {:?} stderr {:?}\n  rs exit {:?} stdout {:?} stderr {:?}",
            ts_out.status.code(),
            stdout(&ts_out),
            stderr(&ts_out),
            rs_out.status.code(),
            stdout(&rs_out),
            stderr(&rs_out)
        ));
        }
    }
}

// ---------------------------------------------------------------------------
// Rust end-to-end: pa-daemon + prime-agent
// ---------------------------------------------------------------------------

#[test]
fn rust_daemon_cli_commands_end_to_end() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let sessions = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions dir");
    let socket = dir.path().join("daemon.sock");
    let cli = PathBuf::from(env!("CARGO_BIN_EXE_prime-agent"));
    let daemon = spawn_daemon(&daemon_binary(), &socket, &agent_dir);
    let socket_str = socket.to_string_lossy().to_string();

    // Golden: empty list (TS binary output).
    let list = run_cli(
        &cli,
        dir.path(),
        &agent_dir,
        &list_args(&socket_str, &["list"]),
    );
    assert_eq!(list.status.code(), Some(0));
    assert_eq!(stdout(&list), "No active agents.\n");

    let list_all = run_cli(
        &cli,
        dir.path(),
        &agent_dir,
        &list_args(&socket_str, &["list", "--all"]),
    );
    assert_eq!(stdout(&list_all), "No agents.\n");

    // Golden: unknown list option (TS binary error).
    let bogus = run_cli(
        &cli,
        dir.path(),
        &agent_dir,
        &list_args(&socket_str, &["list", "--bogus"]),
    );
    assert_eq!(bogus.status.code(), Some(1));
    assert_eq!(stderr(&bogus), "Error: Unknown list option: --bogus\n");

    // One scripted session.
    let script = dir.path().join("script.json");
    std::fs::write(
        &script,
        json!({ "responses": [{ "text": "hello", "delayMs": 0 }] }).to_string(),
    )
    .expect("write script");
    let (mut wire, _hello) = Wire::connect(&daemon.socket);
    let session = create_session(
        &mut wire,
        "c1",
        "parity",
        dir.path(),
        &sessions,
        Some(&script),
    );
    assert_eq!(session.len(), 12, "short active id: {session}");

    // Golden: single-row table shape (header from the TS binary).
    let list = run_cli(
        &cli,
        dir.path(),
        &agent_dir,
        &list_args(&socket_str, &["list"]),
    );
    assert_eq!(list.status.code(), Some(0), "{}", stderr(&list));
    assert_eq!(
        normalize(&stdout(&list)),
        "name id status age model messages clients\n\
         parity <timestamp> idle <time> 0 0\n",
        "table shape must match the TS golden"
    );

    // The --json output carries the daemon's summary rows unmodified.
    let list_json = run_cli(
        &cli,
        dir.path(),
        &agent_dir,
        &list_args(&socket_str, &["list", "--json"]),
    );
    let parsed: Value = serde_json::from_str(&stdout(&list_json)).expect("valid json list");
    let row = &parsed["sessions"][0];
    for key in [
        "id",
        "sessionId",
        "cwd",
        "lifecycle",
        "activity",
        "isSessionActive",
        "isStreaming",
        "isCompacting",
        "attachedClients",
        "messageCount",
        "sessionActions",
    ] {
        assert!(row.get(key).is_some(), "summary row must carry {key}");
    }

    // Golden: rename output (TS binary).
    let rename = run_cli(
        &cli,
        dir.path(),
        &agent_dir,
        &list_args(&socket_str, &["rename", session.as_str(), "renamed"]),
    );
    assert_eq!(rename.status.code(), Some(0), "{}", stderr(&rename));
    assert_eq!(stdout(&rename), format!("Renamed {session} to renamed\n"));

    // Golden: stop output (TS binary).
    let stop = run_cli(
        &cli,
        dir.path(),
        &agent_dir,
        &list_args(&socket_str, &["stop", session.as_str()]),
    );
    assert_eq!(stop.status.code(), Some(0), "{}", stderr(&stop));
    assert_eq!(stdout(&stop), "ok\n");

    let list = run_cli(
        &cli,
        dir.path(),
        &agent_dir,
        &list_args(&socket_str, &["list"]),
    );
    assert_eq!(stdout(&list), "No active agents.\n");

    // Golden: unknown selector error (TS binary).
    let stop_missing = run_cli(
        &cli,
        dir.path(),
        &agent_dir,
        &list_args(&socket_str, &["stop", "missing-selector"]),
    );
    assert_eq!(stop_missing.status.code(), Some(1));
    assert_eq!(
        stderr(&stop_missing),
        "Error: Unknown active session: missing-selector\n"
    );

    // Saved sessions still appear in list --all after the stop.
    let list_all = run_cli(
        &cli,
        dir.path(),
        &agent_dir,
        &list_args(&socket_str, &["list", "--all"]),
    );
    let normalized = normalize(&stdout(&list_all));
    assert_eq!(normalized.lines().count(), 2, "saved row after kill");
    assert!(normalized.contains("<timestamp>"), "{normalized}");

    // send_message by the stopped worker's active id answers with the TS
    // unknown-session error: active ids are not durable, and the catalog
    // keys saved sessions by session id and name only.
    let send = run_cli(
        &cli,
        dir.path(),
        &agent_dir,
        &list_args(&socket_str, &["send", session.as_str(), "hello"]),
    );
    assert_eq!(send.status.code(), Some(1));
    assert_eq!(
        stderr(&send),
        format!("Error: Unknown active session: {session}\n")
    );

    // The saved-session wake (messaging-7): sending by the saved session's
    // NAME wakes it - the supervisor catalog-resolves the selector, spawns
    // a worker over the persisted file, and delivers; the CLI renders the
    // TS golden `Sent to <name>`.
    let send_wake = run_cli(
        &cli,
        dir.path(),
        &agent_dir,
        &list_args(&socket_str, &["send", "renamed", "hello again"]),
    );
    assert_eq!(send_wake.status.code(), Some(0), "{}", stderr(&send_wake));
    assert_eq!(stdout(&send_wake), "Sent to renamed\n");
}

#[test]
fn cli_connect_error_matches_ts_golden() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let missing = dir.path().join("missing.sock");
    let cli = PathBuf::from(env!("CARGO_BIN_EXE_prime-agent"));
    let output = run_cli(
        &cli,
        dir.path(),
        &agent_dir,
        &[
            "--daemon-socket",
            missing.to_string_lossy().as_ref(),
            "list",
        ],
    );
    assert_eq!(output.status.code(), Some(1));
    // Golden (TS): `Error: Failed to connect to the Prime Agent daemon:
    // connect ENOENT <path>. Socket: <path>. Daemon log:
    // <agent-dir>/logs/<socket-basename>.<8-hex>.log.`
    let text = stderr(&output).trim_end().to_string();
    let expected_prefix = format!(
        "Error: Failed to connect to the Prime Agent daemon: connect ENOENT {missing}. Socket: {missing}. Daemon log: ",
        missing = missing.display()
    );
    assert!(
        text.starts_with(&expected_prefix),
        "connect error text: {text}"
    );
    let log_detail = text
        .strip_prefix(&expected_prefix)
        .expect("daemon log detail");
    let log_name = log_detail.rsplit('/').next().expect("daemon log file name");
    let hash_end = log_name
        .strip_prefix(&format!(
            "{}.",
            missing.file_name().unwrap().to_string_lossy()
        ))
        .and_then(|rest| rest.strip_suffix(".log."))
        .expect("daemon log basename and tail");
    assert!(
        log_detail.starts_with(agent_dir.to_string_lossy().as_ref()),
        "log under agent dir: {text}"
    );
    assert_eq!(text, format!("{expected_prefix}{log_detail}"));
    assert_eq!(hash_end.len(), 8, "8-hex log suffix: {text}");
    assert!(
        hash_end.chars().all(|c| c.is_ascii_hexdigit()),
        "hex log suffix: {text}"
    );
}

// ---------------------------------------------------------------------------
// Schedule CLI usage surface: no daemon, validation fires first
// ---------------------------------------------------------------------------

/// The schedule commands' usage errors fire in the public router's
/// validation, before any daemon request, and every valid invocation passes
/// validation and reaches the connection attempt. The goldens are the TS
/// binary's byte-identical output; `--daemon-socket` before the command
/// rotates into the schedule operands, a shape the TS CLI rejects with the
/// same usage error.
#[test]
fn schedule_usage_errors_and_valid_invocations() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(agent_dir.join("sessions")).expect("sessions dir");
    let cli = PathBuf::from(env!("CARGO_BIN_EXE_prime-agent"));
    let rotated_socket = dir.path().join("bogus.sock");
    let rotated_socket = rotated_socket.to_str().expect("socket path");

    let usage_shapes = [
        (
            vec!["schedule", "cancel"],
            "Error: Usage: prime-agent schedule cancel <job-id>\n",
        ),
        (
            vec!["schedule", "cancel", "a", "b"],
            "Error: Usage: prime-agent schedule cancel <job-id>\n",
        ),
        (
            vec!["schedule", "list", "--bogus-flag"],
            "Error: Usage: prime-agent schedule list [--all] [agent] [--json]\n",
        ),
        (
            vec!["--daemon-socket", rotated_socket, "schedule", "list"],
            "Error: Usage: prime-agent schedule list [--all] [agent] [--json]\n",
        ),
        (
            vec![
                "--daemon-socket",
                rotated_socket,
                "schedule",
                "cancel",
                "id",
            ],
            "Error: Usage: prime-agent schedule cancel <job-id>\n",
        ),
    ];
    for (args, golden) in usage_shapes {
        let out = run_cli(&cli, dir.path(), &agent_dir, &args);
        assert_eq!(out.status.code(), Some(1), "{args:?}");
        assert_eq!(stdout(&out), "", "{args:?}");
        assert_eq!(stderr(&out), golden, "{args:?}");
    }

    // Valid invocations pass validation and fail only at the connection
    // attempt (the temp TMPDIR holds no daemon socket): no usage message.
    let valid_shapes = [
        vec!["schedule", "list"],
        vec!["schedule", "list", "--all"],
        vec!["schedule", "list", "-a"],
        vec!["schedule", "list", "--json"],
        vec!["schedule", "list", "some-agent"],
        vec!["schedule", "cancel", "fake-id"],
        vec!["schedule", "cancel", "--json", "fake-id"],
    ];
    for args in valid_shapes {
        let out = run_cli(&cli, dir.path(), &agent_dir, &args);
        assert_eq!(out.status.code(), Some(1), "{args:?}");
        let err = stderr(&out);
        assert!(
            err.starts_with("Error: Failed to connect to the Prime Agent daemon:"),
            "{args:?}: {err}"
        );
    }
}

// ---------------------------------------------------------------------------
// TS differential: both CLIs against the same TS daemon
// ---------------------------------------------------------------------------

#[test]
fn ts_daemon_differential_cli_output() {
    let Some(ts) = ts_binary() else {
        eprintln!("SKIPPED: TS prime-agent binary not found (set PA_TS_BINARY)");
        return;
    };
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let sessions = agent_dir.join("sessions");
    let work = dir.path().join("work");
    std::fs::create_dir_all(&sessions).expect("sessions dir");
    std::fs::create_dir_all(&work).expect("work dir");
    // The `schedule` command cannot take --daemon-socket (TS parity), so the
    // daemon must live on the default socket path under the temp TMPDIR.
    std::env::set_var("TMPDIR", dir.path());
    let socket = pa_daemon::socket::default_daemon_socket_path();
    // The TS daemon does not create the socket's parent directory on bind
    // (the Rust supervisor does), so the default-path socket needs the
    // directory to exist before the TS daemon is spawned.
    std::fs::create_dir_all(socket.parent().expect("socket parent")).expect("socket parent dir");
    let mut daemon_command = Command::new(&ts);
    daemon_command
        .arg("--mode")
        .arg("daemon")
        .arg("--daemon-socket")
        .arg(&socket)
        // The TS CLI resolves its package manifest by walking up from the
        // working directory and stops at the repository root; a Rust
        // checkout has no package.json there, so the daemon must run from
        // the scratch work dir (no manifest anywhere up the walk).
        .current_dir(&work)
        .env("PRIME_AGENT_CODING_AGENT_DIR", &agent_dir)
        .env("TMPDIR", dir.path())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for key in SCRUB_ENV {
        daemon_command.env_remove(key);
    }
    // Teardown symmetry with the Rust daemon: the TS worker's orphan-exit
    // window is the same env var (wire parity), so a killed TS supervisor
    // reaps its workers on the same short bound.
    daemon_command.env(
        pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
        "15000",
    );
    let mut daemon = daemon_command.spawn().expect("spawn TS daemon");
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if UnixStream::connect(&socket).is_ok() {
            break;
        }
        assert!(Instant::now() < deadline, "TS daemon socket never appeared");
        std::thread::sleep(Duration::from_millis(50));
    }

    let rust = PathBuf::from(env!("CARGO_BIN_EXE_prime-agent"));
    let pair = CliPair {
        ts: ts.clone(),
        rust: rust.clone(),
        dir: dir.path().to_path_buf(),
        agent_dir: agent_dir.clone(),
    };
    let mut failures: Vec<String> = Vec::new();
    let compare = |failures: &mut Vec<String>, ts_args: &[&str], rs_args: &[&str], label: &str| {
        pair.compare(failures, ts_args, rs_args, label);
    };

    // Both CLIs against the same TS daemon: identical normalized output.
    compare(&mut failures, &["list"], &["list"], "empty list");
    let (mut wire, hello) = Wire::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello", "TS daemon hello");
    let primary = create_session(&mut wire, "c1", "parity", &work, &sessions, None);
    let secondary = create_session(&mut wire, "c2", "parity-b", &work, &sessions, None);
    let tertiary = create_session(&mut wire, "c3", "parity-c", &work, &sessions, None);
    compare(&mut failures, &["list"], &["list"], "session table");

    let ts_list_json = run_cli(&ts, dir.path(), &agent_dir, &["list", "--json"]);
    let rs_list_json = run_cli(&rust, dir.path(), &agent_dir, &["list", "--json"]);
    let ts_json: Value = serde_json::from_str(&stdout(&ts_list_json)).expect("ts json");
    let rs_json: Value = serde_json::from_str(&stdout(&rs_list_json)).expect("rust json");
    if canonicalize(&ts_json) != canonicalize(&rs_json) {
        failures.push(format!("list --json: ts {ts_json} vs rs {rs_json}"));
    }

    // Both renames target the same session with the same new name.
    let rename: Vec<&str> = vec!["rename", primary.as_str(), "parity-renamed"];
    compare(&mut failures, &rename, &rename, "rename");
    // Sends start a real turn on the target, so the second send to the same
    // session queues; each CLI sends the first message to its own session and
    // must render the same delivered receipt.
    let ts_send = run_cli(
        &ts,
        dir.path(),
        &agent_dir,
        &["send", secondary.as_str(), "differential message"],
    );
    let rs_send = run_cli(
        &rust,
        dir.path(),
        &agent_dir,
        &["send", tertiary.as_str(), "differential message"],
    );
    if ts_send.status.code() != rs_send.status.code()
        || !stdout(&ts_send).starts_with("Sent to ")
        || !stdout(&rs_send).starts_with("Sent to ")
    {
        failures.push(format!(
            "send: ts {:#?} vs rs {:#?}",
            (ts_send.status.code(), stdout(&ts_send), stderr(&ts_send)),
            (rs_send.status.code(), stdout(&rs_send), stderr(&rs_send))
        ));
    }
    compare(
        &mut failures,
        &["schedule", "list"],
        &["schedule", "list"],
        "schedule list",
    );
    let add: Vec<&str> = vec![
        "schedule",
        "add",
        primary.as_str(),
        "every 10 minutes",
        "--",
        "differential job",
    ];
    compare(&mut failures, &add, &add, "schedule add");
    compare(
        &mut failures,
        &["schedule", "list"],
        &["schedule", "list"],
        "schedule list after add",
    );
    compare(
        &mut failures,
        &["schedule", "list", "--all"],
        &["schedule", "list", "--all"],
        "schedule list --all",
    );
    compare(
        &mut failures,
        &["schedule", "list", "--json"],
        &["schedule", "list", "--json"],
        "schedule list --json",
    );
    // Cancel round-trip: the two adds above stored one job per CLI. Each
    // CLI cancels one of them and both render the same receipt, then the
    // same emptied list.
    let ts_schedule_json = run_cli(&ts, dir.path(), &agent_dir, &["schedule", "list", "--json"]);
    let job_ids: Vec<String> = serde_json::from_str::<Value>(&stdout(&ts_schedule_json))
        .expect("schedule list json")
        .get("jobs")
        .and_then(Value::as_array)
        .expect("jobs array")
        .iter()
        .map(|job| job["id"].as_str().expect("job id").to_string())
        .collect();
    assert_eq!(job_ids.len(), 2, "one stored job per CLI add");
    compare(
        &mut failures,
        &["schedule", "cancel", job_ids[0].as_str()],
        &["schedule", "cancel", job_ids[1].as_str()],
        "schedule cancel",
    );
    compare(
        &mut failures,
        &["schedule", "list"],
        &["schedule", "list"],
        "schedule list after cancel",
    );
    // Usage parity: the errors fire in the public router's validation,
    // before any daemon request, and both CLIs render them identically.
    // `--daemon-socket` before the command rotates into the schedule
    // operands; the TS CLI rejects that shape with the same usage error.
    let socket_arg = socket.to_string_lossy().to_string();
    compare(
        &mut failures,
        &["schedule", "cancel"],
        &["schedule", "cancel"],
        "schedule cancel without id",
    );
    compare(
        &mut failures,
        &["schedule", "cancel", "a", "b"],
        &["schedule", "cancel", "a", "b"],
        "schedule cancel with two ids",
    );
    compare(
        &mut failures,
        &["schedule", "list", "--bogus-flag"],
        &["schedule", "list", "--bogus-flag"],
        "schedule list unknown flag",
    );
    compare(
        &mut failures,
        &["--daemon-socket", socket_arg.as_str(), "schedule", "list"],
        &["--daemon-socket", socket_arg.as_str(), "schedule", "list"],
        "daemon-socket before schedule list",
    );
    compare(
        &mut failures,
        &[
            "--daemon-socket",
            socket_arg.as_str(),
            "schedule",
            "cancel",
            "id",
        ],
        &[
            "--daemon-socket",
            socket_arg.as_str(),
            "schedule",
            "cancel",
            "id",
        ],
        "daemon-socket before schedule cancel",
    );
    // TS stops the primary session, the Rust CLI stops the secondary one:
    // both must print the same golden output.
    let stop_ts: Vec<&str> = vec!["stop", primary.as_str()];
    let stop_rs: Vec<&str> = vec!["stop", tertiary.as_str()];
    compare(&mut failures, &stop_ts, &stop_rs, "stop");

    // Saved-session wake on the TS daemon (ground truth): each CLI sends to
    // a session stopped earlier by its own name; both must wake it and
    // render the delivered receipt (`Sent to <name>`). Different targets,
    // so the compared observable is the delivered-receipt line shape.
    let ts_wake = run_cli(
        &ts,
        dir.path(),
        &agent_dir,
        &["send", "parity-renamed", "wake from ts"],
    );
    let rs_wake = run_cli(
        &rust,
        dir.path(),
        &agent_dir,
        &["send", "parity-c", "wake from rs"],
    );
    if ts_wake.status.code() != rs_wake.status.code()
        || stdout(&ts_wake) != "Sent to parity-renamed\n"
        || stdout(&rs_wake) != "Sent to parity-c\n"
    {
        failures.push(format!(
            "send wakes a saved session: ts {:#?} vs rs {:#?}",
            (ts_wake.status.code(), stdout(&ts_wake), stderr(&ts_wake)),
            (rs_wake.status.code(), stdout(&rs_wake), stderr(&rs_wake))
        ));
    }

    let _ = daemon.kill();
    let _ = daemon.wait();
    std::env::remove_var("TMPDIR");
    assert!(
        failures.is_empty(),
        "TS differential mismatches:\n{}",
        failures.join("\n---\n")
    );
}
