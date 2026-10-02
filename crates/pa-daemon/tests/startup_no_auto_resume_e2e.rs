//! The no-auto-resume contract e2e (the takeover field fixes): a daemon
//! boot never creates a worker for a session the user did not ask for.
//!
//! THE FIELD BUG: the operator's friend installed the Rust port over a
//! machine the TypeScript product had owned, and on the first Rust daemon
//! boot a random old session he had not had running came up. The old
//! spec §6 step-3 "scheduled-work re-arm" ran at EVERY boot (normal boots
//! included), scanned the shared store's `session-artifacts` for due
//! active jobs with no live worker, and CREATED a worker for each — so a
//! TS-era session file with a stale heartbeat row (`status: "active"`,
//! `nextRunAt` long past) booted itself. The TS product's own wake scan
//! gates jobs behind the session's durable state and the family walk;
//! the ungated re-arm did not.
//!
//! THE NEW CONTRACT: a session that was not running when the daemon
//! stopped stays down after the daemon restarts; a schedule fires only
//! while its session is live (the worker's in-process scheduler, armed
//! at bind time when the user actually starts the session); due
//! heartbeats on not-running sessions stay DORMANT and stay surfaced by
//! the heartbeat catalog (`heartbeats_list`'s passive rows) instead of
//! auto-firing. The boot only logs how many are dormant.
//!
//! The provider is a local always-200 OpenAI-completions mock, so a
//! wrongly-booted session would run its turn and fail these asserts
//! loudly (the resume-positive half needs it anyway).
#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
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

impl Daemon {
    /// Wait for the supervisor process to exit (the client `shutdown`).
    fn wait_exit(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while self.child.try_wait().expect("try wait").is_none() {
            assert!(Instant::now() < deadline, "supervisor did not exit");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// One always-200 SSE answer per request (a wrongly-booted session would
/// turn against it; the resumed session's heartbeat turn does).
fn spawn_mock(answer: &'static str) -> PathBuf /* url */ {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
    let url = format!(
        "http://127.0.0.1:{}/v1",
        listener.local_addr().unwrap().port()
    );
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            std::thread::spawn(move || {
                let _ = serve(stream, answer);
            });
        }
    });
    PathBuf::from(url)
}

fn chunk(delta: &Value, finish_reason: Option<&str>) -> String {
    json!({
        "id": "chatcmpl-dormant",
        "object": "chat.completion.chunk",
        "created": 1_750_000_000,
        "model": "mock-1",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    })
    .to_string()
}

fn serve(mut stream: TcpStream, answer: &str) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        if line == "\r\n" {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or_default();
        }
    }
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body)?;
    }
    let mut payload = String::new();
    for data in [
        chunk(&json!({"role": "assistant", "content": answer}), None),
        chunk(&json!({}), Some("stop")),
    ] {
        payload.push_str("data: ");
        payload.push_str(&data);
        payload.push_str("\n\n");
    }
    payload.push_str("data: [DONE]\n\n");
    stream.write_all(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{payload}"
        )
        .as_bytes(),
    )
}

#[allow(clippy::zombie_processes)]
fn spawn_daemon(socket: &Path, agent_dir: &Path) -> Daemon {
    let child = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        // A resumed worker has no create-config model: it falls back to
        // the process pair, exactly like the TS daemon's default session
        // config.
        .env("PRIME_AGENT_MODEL_PROVIDER", "prime-inference")
        .env("PRIME_AGENT_MODEL", "mock-1")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // A supervisor killed at teardown must not leak its session
        // workers into later test binaries: the worker's supervisor-lost
        // exit runs on this short window instead of the 5-minute default.
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
        let writer = stream.try_clone().expect("clone socket");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer,
        };
        let hello = client.read_line();
        (client, hello)
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
        let deadline = Instant::now() + Duration::from_secs(30);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        loop {
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => line.clear(),
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

    fn read_response(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }

    /// The live roster (`list`): every resident session's active id.
    fn listed_sessions(&mut self, poll_id: &str) -> Vec<String> {
        self.send_command(poll_id, &json!({ "type": "list" }));
        let list = self.read_response(poll_id);
        assert_eq!(list["success"], true, "list failed: {list}");
        list["data"]["sessions"]
            .as_array()
            .expect("sessions array")
            .iter()
            .map(|summary| {
                summary["activeSessionId"]
                    .as_str()
                    .or_else(|| summary["id"].as_str())
                    .expect("active id")
                    .to_string()
            })
            .collect()
    }

    fn shutdown(&mut self) {
        self.send_command("sd", &json!({ "type": "shutdown" }));
        let shutdown = self.read_response("sd");
        assert_eq!(shutdown["success"], true, "shutdown failed: {shutdown}");
    }
}

fn wait_until<T>(deadline: Duration, mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + deadline;
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(Instant::now() < deadline, "condition never became true");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// One session's transcript through the supervisor route.
fn messages(client: &mut Client, id: &str, active_session_id: &str) -> String {
    client.send_command(
        id,
        &json!({ "type": "get_messages", "activeSessionId": active_session_id }),
    );
    let response = client.read_response(id);
    assert_eq!(response["success"], true, "get_messages failed: {response}");
    serde_json::to_string(&response["data"]).expect("messages json")
}

/// A TS-ERA session file (the entry shapes the TypeScript product writes:
/// the session header, `session_info`, the `session_state` row with the
/// `{status}` object, a user message) — the shared-store file a fresh
/// Rust install reads. `state` is the durable lifecycle status TS leaves
/// on the file ("active" for a session that was never archived, the
/// shape the old ungated re-arm used to wake).
fn write_ts_era_session(agent_dir: &Path, session_id: &str, name: &str, state: &str) -> PathBuf {
    let sessions = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions dir");
    let path = sessions.join(format!("{session_id}.jsonl"));
    let lines = json_lines(vec![
        json!({
            "type": "session",
            "id": session_id,
            "timestamp": "2026-01-05T10:00:00.000Z",
            "cwd": "/work",
        }),
        json!({
            "type": "session_info",
            "id": "e2",
            "parentId": "top",
            "timestamp": "2026-01-05T10:00:01.000Z",
            "name": name,
        }),
        json!({
            "type": "session_state",
            "id": "e3",
            "parentId": "e2",
            "timestamp": "2026-01-05T10:00:02.000Z",
            "state": { "status": state },
        }),
        json!({
            "type": "message",
            "id": "e4",
            "parentId": "e3",
            "timestamp": "2026-01-05T10:00:03.000Z",
            "message": { "role": "user", "content": "the ts era turn", "timestamp": 1_767_000_000_000_u64 },
        }),
    ]);
    std::fs::write(&path, lines).expect("write session file");
    path
}

/// The session-artifacts `scheduled-jobs.json` store shape (TS
/// `AgentCronJobStore::forSessionArtifacts`): `{jobs, dispatches}`.
fn write_scheduled_jobs(agent_dir: &Path, session_id: &str, jobs: &[Value]) {
    let partition = agent_dir.join("session-artifacts").join(session_id);
    std::fs::create_dir_all(&partition).expect("artifacts partition");
    std::fs::write(
        partition.join("scheduled-jobs.json"),
        serde_json::to_string(&json!({ "jobs": jobs, "dispatches": [] })).expect("jobs json"),
    )
    .expect("write scheduled-jobs.json");
}

/// A due-looking scheduled job row: active, `nextRunAt` in the past (a
/// stale heartbeat whose session has not run under any daemon for days).
fn due_job(
    job_id: &str,
    source: &str,
    session_id: &str,
    session_file: &Path,
    prompt: &str,
) -> Value {
    json!({
        "id": job_id,
        "status": "active",
        "source": source,
        "activeSessionId": session_id,
        "sessionId": session_id,
        "sessionFile": session_file.to_string_lossy(),
        "cwd": "/work",
        "prompt": prompt,
        "schedule": { "kind": "interval", "expression": "every 2m", "intervalMs": 120_000 },
        "createdAt": "2026-01-05T10:00:04.000Z",
        "updatedAt": "2026-01-05T10:00:04.000Z",
        "nextRunAt": "2020-01-01T00:00:00.000Z",
        "runCount": 0,
    })
}

/// Compose JSONL lines without a trailing-blank entry.
fn json_lines(entries: Vec<Value>) -> String {
    let mut out = String::new();
    for entry in entries {
        out.push_str(&serde_json::to_string(&entry).expect("entry json"));
        out.push('\n');
    }
    out
}

fn write_models_json(agent_dir: &Path, url: &Path) {
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "prime-inference": {
                    "api": "openai-completions",
                    "baseUrl": url.to_string_lossy(),
                    "apiKey": "sk-dormant",
                    "models": [
                        {
                            "id": "mock-1",
                            "name": "Mock 1",
                            "api": "openai-completions",
                            "contextWindow": 128_000,
                            "maxTokens": 4096
                        }
                    ]
                }
            }
        })
        .to_string(),
    )
    .expect("write models.json");
}

/// THE STARTUP-SCAN NO-AUTO-RESUME TEST: a due scheduled job (a stale
/// heartbeat AND a plain cron row) never boots its session at daemon
/// start. The daemon log carries the dormant report instead, the
/// heartbeat catalog still surfaces the row (dormant, not fired), and
/// the session file gains nothing. The positive half: once the USER
/// resumes the session, its schedule arms and the due heartbeat fires
/// through the live worker's own scheduler.
#[test]
fn a_due_scheduled_job_never_boots_its_session_at_daemon_start() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let url = spawn_mock("dormant reply");
    write_models_json(&agent_dir, &url);

    let session_id = "11111111-2222-3333-4444-555555555555";
    let session_file = write_ts_era_session(&agent_dir, session_id, "the ts era session", "active");
    let file_before = std::fs::read(&session_file).expect("read before");

    // TWO due rows: a stale heartbeat and a plain cron job.
    write_scheduled_jobs(
        &agent_dir,
        session_id,
        &[
            due_job(
                "job-stale-heartbeat",
                "heartbeat",
                session_id,
                &session_file,
                "the stale heartbeat ping",
            ),
            due_job(
                "job-stale-cron",
                "cron",
                session_id,
                &session_file,
                "the stale cron prompt",
            ),
        ],
    );

    let socket = dir.path().join("dormant.sock");
    let mut daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    // The old re-arm woke the session within a beat of the adoption
    // settle; hold the window open so a regression boots and fails.
    std::thread::sleep(Duration::from_secs(2));
    let listed = client.listed_sessions("l1");
    assert!(
        listed.is_empty(),
        "a due scheduled job booted a session at daemon start: {listed:?}"
    );

    // The session file gained NOTHING: no heartbeat prompt row, no cron
    // prompt row, no state flip.
    let file_after = std::fs::read(&session_file).expect("read after");
    assert_eq!(
        file_before, file_after,
        "the not-running session's file changed at boot"
    );

    // The boot's dormant report: both due jobs named, counted, never
    // fired.
    let log_path = pa_daemon::paths::daemon_log_path(&socket, &agent_dir);
    let log = std::fs::read_to_string(&log_path).unwrap_or_default();
    for needle in [
        "job-stale-heartbeat",
        "job-stale-cron",
        "stays dormant: no session auto-boots on daemon start",
        "2 due scheduled job(s) stayed dormant on not-running sessions",
    ] {
        assert!(
            log.contains(needle),
            "the daemon log lacks the dormant report line [{needle}]: {log}"
        );
    }

    // DORMANT, SURFACED: the heartbeat catalog still lists the passive
    // heartbeat row (the agents-view surface — "a scheduled heartbeat
    // exists"), and the cron catalog the cron row.
    client.send_command("hb1", &json!({ "type": "heartbeats_list" }));
    let heartbeats = client.read_response("hb1");
    assert_eq!(heartbeats["success"], true, "{heartbeats}");
    let rows = heartbeats["data"]["heartbeats"].as_array().expect("rows");
    let heartbeat_row = rows
        .iter()
        .find(|row| row["job"]["id"] == json!("job-stale-heartbeat"))
        .expect("the dormant heartbeat row must stay surfaced in the catalog");
    assert_eq!(heartbeat_row["sessionName"], json!("the ts era session"));
    client.send_command("cr1", &json!({ "type": "cron_list" }));
    let crons = client.read_response("cr1");
    assert_eq!(crons["success"], true, "{crons}");
    let cron_rows = crons["data"]["jobs"].as_array().expect("cron rows");
    assert!(
        cron_rows
            .iter()
            .any(|row| row["id"] == json!("job-stale-cron")),
        "the dormant cron row must stay surfaced in the catalog: {cron_rows:?}"
    );

    // THE POSITIVE HALF: the user resumes the session — the schedule
    // arms for a session the user actually starts, and the due heartbeat
    // fires through the live worker's own scheduler.
    client.send_command(
        "c1",
        &json!({ "type": "create", "sessionPath": session_file.to_string_lossy() }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "resume create failed: {created}");
    let active_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["activeSessionId"].as_str())
        .expect("active id")
        .to_string();

    // The heartbeat prompt row lands in the transcript (the fire
    // delivers through the live queue) and the mock answers the turn.
    let fired = wait_until(Duration::from_secs(30), || {
        let text = messages(&mut client, "gm1", &active_id);
        (text.contains("the stale heartbeat ping") && text.contains("dormant reply"))
            .then_some(text)
    });
    assert!(
        fired.contains("the stale heartbeat ping"),
        "the heartbeat fired once the user resumed the session"
    );

    client.shutdown();
    daemon.wait_exit();
}

/// THE STALE-HEARTBEAT-DORMANT TEST (the field shape): a TS-era session
/// file with a due-looking heartbeat — the friend's "random old session"
/// — stays DOWN across daemon boots and restarts. The active-state
/// file stays down and surfaced; the archived-state file (a session TS
/// stopped on purpose) stays down and out of the catalog (TS parity).
#[test]
fn a_stale_ts_era_heartbeat_stays_dormant_across_daemon_restarts() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let url = spawn_mock("should not run");
    write_models_json(&agent_dir, &url);

    let live_session = "aaaaaaaa-0000-4000-8000-000000000001";
    let live_file = write_ts_era_session(&agent_dir, live_session, "old ts session", "active");
    let stopped_session = "aaaaaaaa-0000-4000-8000-000000000002";
    let stopped_file = write_ts_era_session(
        &agent_dir,
        stopped_session,
        "stopped ts session",
        "archived",
    );
    write_scheduled_jobs(
        &agent_dir,
        live_session,
        &[due_job(
            "job-field-heartbeat",
            "heartbeat",
            live_session,
            &live_file,
            "the heartbeat that used to boot the machine",
        )],
    );
    write_scheduled_jobs(
        &agent_dir,
        stopped_session,
        &[due_job(
            "job-archived-heartbeat",
            "heartbeat",
            stopped_session,
            &stopped_file,
            "the archived session heartbeat",
        )],
    );
    let live_before = std::fs::read(&live_file).expect("read live");
    let stopped_before = std::fs::read(&stopped_file).expect("read stopped");

    // Boot one.
    let socket = dir.path().join("restart.sock");
    let mut daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");
    std::thread::sleep(Duration::from_secs(2));
    assert!(
        client.listed_sessions("l1").is_empty(),
        "the stale TS-era heartbeat booted a session on daemon start"
    );
    // The catalog surfaces the active-state row; the archived session's
    // row is hidden (the TS parity state gate).
    client.send_command("hb1", &json!({ "type": "heartbeats_list" }));
    let heartbeats = client.read_response("hb1");
    let ids: Vec<&str> = heartbeats["data"]["heartbeats"]
        .as_array()
        .expect("rows")
        .iter()
        .filter_map(|row| row["job"]["id"].as_str())
        .collect();
    assert_eq!(ids, vec!["job-field-heartbeat"], "{heartbeats}");

    client.shutdown();
    daemon.wait_exit();

    // Boot two: a session that was not running when the daemon stopped
    // stays DOWN after the daemon restarts.
    let mut daemon2 = spawn_daemon(&socket, &agent_dir);
    let (mut client2, hello2) = Client::connect(&socket);
    assert_eq!(hello2["type"], "daemon_hello");
    std::thread::sleep(Duration::from_secs(2));
    assert!(
        client2.listed_sessions("l2").is_empty(),
        "the stale TS-era heartbeat booted a session after the daemon restart"
    );

    // Neither file gained a row: nothing fired, nothing woke.
    assert_eq!(
        std::fs::read(&live_file).expect("read live"),
        live_before,
        "the active-state session file changed"
    );
    assert_eq!(
        std::fs::read(&stopped_file).expect("read stopped"),
        stopped_before,
        "the archived session file changed"
    );

    client2.shutdown();
    daemon2.wait_exit();
}
