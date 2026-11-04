// large_futures: stack futures on hot paths by design. too_many_lines: style gate
// only. Casts: 64-bit targets; narrowing sits at bounded OS/protocol boundaries.
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

//! End-to-end daemon-command tests: spawn the real `pa-daemon` supervisor on a
//! temp socket, drive `prime-agent` list/stop/rename against it, and diff the
//! output against goldens captured from the installed TS `prime-agent` binary.
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

/// Env keys this box's own worker sets; they must not leak into spawned
/// daemons. `PI_PACKAGE_DIR` too: it redirects the package dir both binaries resolve.
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
/// binary (cargo builds the tested crate's bins only).
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
    // A supervisor killed at teardown must not leak its session workers: the
    // supervisor-lost exit runs on this short window, not the 5-minute default.
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

/// A raw JSONL protocol client, mirroring the `supervisor_e2e` harness.
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

    fn send_command(&mut self, id: &str, command: &Value) {
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
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("daemon closed the connection"),
                Ok(_) if line.trim().is_empty() => line.clear(),
                Ok(_) => return serde_json::from_str(line.trim()).expect("parse daemon line"),
                Err(_) if Instant::now() < deadline => {}
                Err(error) => panic!("timed out waiting for daemon line: {error}"),
            }
        }
    }

    fn request(&mut self, id: &str, command: &Value) -> Value {
        self.send_command(id, command);
        loop {
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }
}

/// Create one session on the scripted engine.
fn create_session(
    wire: &mut Wire,
    id: &str,
    name: &str,
    cwd: &Path,
    session_dir: &Path,
    script: &Path,
) -> String {
    let config = json!({
        "cwd": cwd.to_string_lossy(),
        "sessionDir": session_dir.to_string_lossy(),
        "script": script.to_string_lossy(),
    });
    let response = wire.request(
        id,
        &json!({ "type": "create", "name": name, "config": config }),
    );
    assert_eq!(response["success"], true, "create failed: {response}");
    response["data"]["activeSessionId"]
        .as_str()
        .or_else(|| response["data"]["id"].as_str())
        .expect("active session id")
        .to_string()
}

/// Run a CLI in an isolated env (agent dir + TMPDIR point into the temp dir).
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

/// Replace volatile tokens (ages, hex ids, uuids, timestamps) so outputs compare equal.
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
    // The strict, fixed-length id shapes are matched first: a 12-char hex
    // display id can read as an age (eleven digits plus a `d` suffix), and
    // the age matcher would otherwise fold it into `<time>` and break the
    // golden on a legal id draw.
    if is_hex_id(token) || is_uuid(token) || is_iso_timestamp(token) || is_local_date(token) {
        return "<timestamp>".to_string();
    }
    if is_age(token) || is_clock(token) || token == "AM" || token == "PM" {
        return "<time>".to_string();
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

#[test]
fn hex_display_id_normalizes_as_a_timestamp_even_when_it_reads_as_an_age() {
    // The display id is the last 12 hex chars of a random uuid, so one
    // draw in ~2800 is eleven digits plus `d` — the exact shape of the
    // age matcher. It is an id, and must fold into `<timestamp>` (the
    // CI flake this regression test pins; the real ages keep `<time>`).
    assert_eq!(normalize_token("12345678901d"), "<timestamp>");
    assert_eq!(normalize_token("b72ad7009b11"), "<timestamp>");
    assert_eq!(normalize_token("3s"), "<time>");
    assert_eq!(normalize_token("2h"), "<time>");
    assert_eq!(normalize_token("10:34:59"), "<time>");
    assert_eq!(normalize_token("PM"), "<time>");
}

/// CLI args with the daemon socket flag prepended.
fn list_args<'a>(socket: &'a str, rest: &[&'a str]) -> Vec<&'a str> {
    let mut args: Vec<&'a str> = vec!["--daemon-socket", socket];
    args.extend(rest.iter().copied());
    args
}

// Rust end-to-end: pa-daemon + prime-agent

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

    let bogus = run_cli(
        &cli,
        dir.path(),
        &agent_dir,
        &list_args(&socket_str, &["list", "--bogus"]),
    );
    assert_eq!(bogus.status.code(), Some(1));
    assert_eq!(stderr(&bogus), "Error: Unknown list option: --bogus\n");

    let sessions_empty = run_cli(
        &cli,
        dir.path(),
        &agent_dir,
        &list_args(&socket_str, &["sessions"]),
    );
    assert_eq!(sessions_empty.status.code(), Some(0));
    assert_eq!(stdout(&sessions_empty), "No active agents.\n");

    let sessions_all = run_cli(
        &cli,
        dir.path(),
        &agent_dir,
        &list_args(&socket_str, &["sessions", "--all"]),
    );
    assert_eq!(stdout(&sessions_all), "No agents.\n");

    let sessions_bogus = run_cli(
        &cli,
        dir.path(),
        &agent_dir,
        &list_args(&socket_str, &["sessions", "--bogus"]),
    );
    assert_eq!(sessions_bogus.status.code(), Some(1));
    assert_eq!(
        stderr(&sessions_bogus),
        "Error: Unknown sessions option: --bogus\n"
    );

    let script = dir.path().join("script.json");
    std::fs::write(
        &script,
        json!({ "responses": [{ "text": "hello", "delayMs": 0 }] }).to_string(),
    )
    .expect("write script");
    let (mut wire, _hello) = Wire::connect(&daemon.socket);
    let session = create_session(&mut wire, "c1", "parity", dir.path(), &sessions, &script);
    assert_eq!(session.len(), 12, "short active id: {session}");

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

    // Golden: the sessions operator table over the live session (TS binary
    // shape): the last-heard, activity, error, and usage cells stay empty for
    // a healthy idle session.
    let sessions_table = run_cli(
        &cli,
        dir.path(),
        &agent_dir,
        &list_args(&socket_str, &["sessions"]),
    );
    assert_eq!(
        sessions_table.status.code(),
        Some(0),
        "{}",
        stderr(&sessions_table)
    );
    assert_eq!(
        normalize(&stdout(&sessions_table)),
        "name status activity last heard error usage\nparity idle\n",
        "sessions table shape must match the TS golden"
    );

    // The sessions --json dump is the same list RPC data (the sessions
    // command reuses it).
    let sessions_json = run_cli(
        &cli,
        dir.path(),
        &agent_dir,
        &list_args(&socket_str, &["sessions", "--json"]),
    );
    let parsed: Value = serde_json::from_str(&stdout(&sessions_json)).expect("valid json sessions");
    assert_eq!(parsed["sessions"][0]["sessionName"], "parity");

    let rename = run_cli(
        &cli,
        dir.path(),
        &agent_dir,
        &list_args(&socket_str, &["rename", session.as_str(), "renamed"]),
    );
    assert_eq!(rename.status.code(), Some(0), "{}", stderr(&rename));
    assert_eq!(stdout(&rename), format!("Renamed {session} to renamed\n"));

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

    // send_message by the stopped worker's active id answers the unknown-session
    // error: active ids are not durable; the catalog keys saved sessions by id and name.
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

    // The saved-session wake (messaging-7): sending by the NAME wakes it — the
    // catalog-resolves the selector, spawns a worker, and delivers.
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

// Schedule CLI usage surface: no daemon, validation fires first

/// The schedule commands' usage errors fire in the router's validation, before
/// any daemon request (`--daemon-socket` before the command rotates into the
/// operands; the TS CLI rejects the same shape).
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

    // Valid shapes pass validation and fail only at the connection attempt.
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
