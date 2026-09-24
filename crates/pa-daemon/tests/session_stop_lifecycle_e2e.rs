//! End-to-end verifier for the stop/delete lifecycle (the zombie fix):
//! stopping a session must cancel its goals' continuation paths AND its
//! scheduled jobs (heartbeats), and no wake pass — the boot re-arm, the
//! descriptor adoption, the schedule delivery — may revive the stopped
//! session. The TS contract (daemon-mode `closeSessionOnce("killed")` ->
//! `cancelScheduledJobsForSession`, the supervisor's
//! `finalizeArchivedWorkerStop`, `isPersistedCronJobRunnable`,
//! `collectPassiveScheduledJobs`): a KILLED session's jobs cancel and its
//! file archives; a CRASHED session's jobs survive and it revives.
//!
//! The flow: two faux-scripted sessions over one real daemon — A with an
//! active goal and a heartbeat (the zombie-orchestrator shape), B with a
//! heartbeat. A is killed through the wire `kill` (the stop path); both
//! workers are then hard-crashed with the supervisor (the adoption +
//! re-arm window), the supervisor restarts, and a tombstoned stop
//! descriptor for A is planted to prove the interrupted-stop adoption
//! finishes the stop instead of relaunching the killed worker. B (no
//! stop) must come back — the wake model survives crashes — while A must
//! stay dead: no resurrection, no continuation, its jobs cancelled on
//! disk, its file archived.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const OBJECTIVE: &str = "keep the lane alive until merged";

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

/// One client connection over the supervisor socket.
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
        let deadline = Instant::now() + Duration::from_mins(5);
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

    fn request(&mut self, id: &str, command: Value) -> Value {
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
        let deadline = Instant::now() + Duration::from_mins(5);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }

    /// The active sessions the supervisor lists (active id + session id).
    fn listed_sessions(&mut self) -> Vec<(String, String)> {
        let response = self.request("list", json!({ "type": "list" }));
        assert_eq!(response["success"], true, "list failed: {response}");
        response["data"]["sessions"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|summary| {
                (
                    summary["id"].as_str().unwrap_or_default().to_string(),
                    summary["sessionId"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string(),
                )
            })
            .collect()
    }
}

/// One faux-scripted session over the daemon: its identities — the active
/// id (the worker's addressable id) and the durable session id (the
/// session-file stem and the artifact-partition key, the uuid the create
/// answers as `sessionId`).
struct Session {
    agent_dir: PathBuf,
    #[allow(dead_code)]
    active_id: String,
    session_id: String,
}

fn create_session(
    client: &mut Client,
    id: &str,
    dir: &Path,
    agent_dir: &Path,
    script: &Path,
    name: &str,
) -> Session {
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("session dir");
    let created = client.request(
        id,
        json!({
            "type": "create",
            "config": {
                "cwd": dir.to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
                "script": script.to_string_lossy(),
                "name": name,
            },
        }),
    );
    assert_eq!(created["success"], true, "create failed: {created}");
    let active_id = created["data"]["activeSessionId"]
        .as_str()
        .or_else(|| created["data"]["id"].as_str())
        .expect("active session id")
        .to_string();
    let session_id = created["data"]["sessionId"]
        .as_str()
        .expect("durable session id")
        .to_string();
    Session {
        agent_dir: agent_dir.to_path_buf(),
        active_id,
        session_id,
    }
}

impl Session {
    fn session_file(&self) -> PathBuf {
        self.agent_dir
            .join("sessions")
            .join(format!("{}.jsonl", self.session_id))
    }

    fn scheduled_jobs_path(&self) -> PathBuf {
        self.agent_dir
            .join("session-artifacts")
            .join(&self.session_id)
            .join("scheduled-jobs.json")
    }

    /// The latest session_state status of the session file.
    fn session_state(&self) -> String {
        let mut state = String::new();
        for line in std::fs::read_to_string(self.session_file())
            .expect("session file readable")
            .lines()
        {
            let Ok(entry) = serde_json::from_str::<Value>(line.trim()) else {
                continue;
            };
            if entry.get("type").and_then(Value::as_str) == Some("session_state") {
                if let Some(status) = entry["state"]["status"].as_str() {
                    state = status.to_string();
                }
            }
        }
        state
    }

    /// The session file's `thread_goal_state` custom rows (the durable goal
    /// record the continuation loop writes).
    fn goal_state_rows(&self) -> usize {
        std::fs::read_to_string(self.session_file())
            .expect("session file readable")
            .lines()
            .filter(|line| !line.trim().is_empty())
            .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
            .filter(|entry| {
                entry.get("type").and_then(Value::as_str) == Some("custom")
                    && entry.get("customType").and_then(Value::as_str) == Some("thread_goal_state")
            })
            .count()
    }

    fn file_rows(&self) -> usize {
        std::fs::read_to_string(self.session_file())
            .expect("session file readable")
            .lines()
            .filter(|line| !line.trim().is_empty())
            .count()
    }

    fn job_status(&self) -> Option<String> {
        let content = std::fs::read_to_string(self.scheduled_jobs_path()).ok()?;
        let value: Value = serde_json::from_str(&content).ok()?;
        value["jobs"][0]["status"].as_str().map(str::to_string)
    }
}

/// A killed session with a goal and a heartbeat stays dead across the
/// supervisor restart: its scheduled jobs cancel at the kill (durable
/// store rows), its session file archives, the boot re-arm never wakes
/// it, the tombstoned-stop adoption finishes the stop instead of
/// relaunching the killed worker, and its goal record freezes (no
/// continuation). The crashed sibling (no stop) comes back — the wake
/// model survives crashes; only the stop kills it.
#[test]
fn kill_cancels_goal_and_heartbeat_and_no_wake_revives_the_session() {
    let root = tempfile::TempDir::new().expect("temp dir");
    let dir = root.path().to_path_buf();
    let agent_dir = dir.join("agent");
    let socket = dir.join("stop.sock");
    let script = dir.join("faux.json");
    std::fs::write(
        &script,
        json!({
            "engine": "faux",
            "responses": [
                { "text": "the lane works on" },
                { "text": "the lane works on" },
                { "text": "the lane works on" },
                { "text": "the lane works on" },
                { "text": "the lane works on" },
                { "text": "the lane works on" },
                { "text": "the lane works on" },
                { "text": "the lane works on" },
            ]
        })
        .to_string(),
    )
    .expect("write faux script");

    // The first daemon generation: sessions A (goal + heartbeat) and B
    // (heartbeat) over one supervisor.
    let supervisor = spawn_supervisor(&socket, &agent_dir);
    let mut client = Client::connect(&socket);
    let a = create_session(&mut client, "c-a", &dir, &agent_dir, &script, "stop-lane-a");
    let b = create_session(&mut client, "c-b", &dir, &agent_dir, &script, "stop-lane-b");

    // A's pre-kill worker descriptor (the `<worker id>.json` record —
    // the per-worker recovery journal also names the session, so the
    // match filters the descriptor file itself): the stop path deletes
    // it at the kill, and the crash-window probe replants it with the
    // stop tombstone.
    let (planted_path, planted_content) = {
        let descriptor_dir = pa_daemon::descriptor::descriptor_dir(&agent_dir, &socket);
        let found = std::fs::read_dir(&descriptor_dir)
            .expect("descriptor dir readable")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.extension().and_then(|extension| extension.to_str()) == Some("json")
                    && std::fs::read_to_string(path)
                        .map(|content| content.contains(&a.session_id))
                        .unwrap_or(false)
            })
            .expect("A's pre-kill worker descriptor");
        let content = std::fs::read_to_string(&found).expect("descriptor readable");
        (found, content)
    };
    let descriptor_dir = pa_daemon::descriptor::descriptor_dir(&agent_dir, &socket);

    // A: the zombie-orchestrator shape — an active goal plus a
    // lane-liveness heartbeat.
    let started = client.request(
        "a-goal",
        json!({
            "type": "prompt_and_wait",
            "activeSessionId": a.active_id,
            "message": format!("/goal {OBJECTIVE}"),
        }),
    );
    assert_eq!(started["success"], true, "goal start failed: {started}");
    assert!(
        a.goal_state_rows() > 0,
        "the started goal persisted its row"
    );
    let heartbeat = client.request(
        "a-hb",
        json!({
            "type": "heartbeat_set",
            "activeSessionId": a.active_id,
            "schedule": "every 10s",
            "prompt": "liveness ping",
        }),
    );
    assert_eq!(
        heartbeat["success"], true,
        "heartbeat_set failed: {heartbeat}"
    );
    assert_eq!(a.job_status().as_deref(), Some("active"));

    // B: the crashed sibling — a heartbeat, no stop.
    let heartbeat = client.request(
        "b-hb",
        json!({
            "type": "heartbeat_set",
            "activeSessionId": b.active_id,
            "schedule": "every 10s",
            "prompt": "liveness ping",
        }),
    );
    assert_eq!(
        heartbeat["success"], true,
        "sibling heartbeat failed: {heartbeat}"
    );
    assert_eq!(b.job_status().as_deref(), Some("active"));

    // THE STOP: A dies through the wire kill. Its jobs cancel durably
    // (TS cancelScheduledJobsForSession) and its file archives.
    let killed = client.request(
        "a-kill",
        json!({ "type": "kill", "activeSessionId": a.active_id }),
    );
    assert_eq!(killed["success"], true, "kill failed: {killed}");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let status = a.job_status();
        if status.as_deref() == Some("cancelled") || Instant::now() > deadline {
            assert_eq!(
                status.as_deref(),
                Some("cancelled"),
                "the killed session's heartbeat never cancelled"
            );
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(a.session_state(), "archived");
    let goal_rows_at_kill = a.goal_state_rows();
    let file_rows_at_kill = a.file_rows();

    // The crash window: both workers hard-crash with the supervisor, with
    // A's stop tombstone planted back — a supervisor that died between the
    // kill reply and the cleanup leaves exactly this descriptor (the
    // pre-kill capture above, with the tombstone fields the interrupted
    // stop would have persisted).
    let mut tombstoned: Value =
        serde_json::from_str(&planted_content).expect("A's descriptor json");
    tombstoned["stopRequestedAt"] = json!("2026-09-23T00:00:00.000Z");
    tombstoned["archiveOnStop"] = json!(true);
    let planted_content = tombstoned.to_string();
    drop(client);
    drop(supervisor);
    // Kill every worker process the old generation left behind: B's from
    // its live descriptor, and A's from the captured pre-kill descriptor
    // (the stop already deleted the live one, so the capture is the only
    // place its pid survives).
    let mut worker_pids: Vec<u64> = Vec::new();
    if let Some(pid) = tombstoned["pid"].as_u64() {
        worker_pids.push(pid);
    }
    for entry in std::fs::read_dir(&descriptor_dir)
        .expect("descriptor dir readable")
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        if !content.contains(&b.session_id) {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&content) else {
            continue;
        };
        // A mid-write artifact (the atomic persist's temp file or a
        // half-flushed descriptor) carries no pid: nothing to signal.
        if let Some(pid) = value["pid"].as_u64() {
            worker_pids.push(pid);
        }
    }
    for pid in worker_pids {
        let _ = Command::new("kill").arg("-9").arg(pid.to_string()).status();
    }
    // A's stop tombstone is in place for the next boot's adoption scan.
    std::fs::write(&planted_path, planted_content).expect("replant the tombstoned descriptor");
    std::fs::remove_file(&socket).ok();

    // The second generation: the adoption scan must finish A's stop (the
    // tombstone) and relaunch B (the plain crash).
    let supervisor = spawn_supervisor(&socket, &agent_dir);
    let mut client = Client::connect(&socket);

    // The tombstoned stop finishes instead of relaunching: the planted
    // descriptor goes away.
    let deadline = Instant::now() + Duration::from_secs(20);
    while planted_path.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(
        !planted_path.exists(),
        "the tombstoned stop's adoption never finished (the descriptor survived)"
    );

    // The crashed sibling comes back (the adoption relaunch, or the boot
    // re-arm waking its due heartbeat): the wake model survives crashes.
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let sessions = client.listed_sessions();
        if sessions
            .iter()
            .any(|(active, id)| *active == b.active_id || *id == b.session_id)
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the crashed sibling never came back (the wake model must survive crashes)"
        );
        std::thread::sleep(Duration::from_millis(200));
    }

    // THE ACCEPTANCE: the killed session never revives across the window
    // (an active `every 10s` heartbeat would have woken it within the window).
    let window = Instant::now() + Duration::from_secs(12);
    while Instant::now() < window {
        let sessions = client.listed_sessions();
        assert!(
            !sessions
                .iter()
                .any(|(active, id)| *active == a.active_id || *id == a.session_id),
            "the killed session resurrected: {sessions:?}"
        );
        std::thread::sleep(Duration::from_millis(500));
    }
    // No continuation for the stopped session: the goal record froze at
    // the kill (a revived goal loop would have written more rows), and
    // no new file rows landed after the kill.
    assert_eq!(
        a.goal_state_rows(),
        goal_rows_at_kill,
        "the stopped session's goal churned on"
    );
    assert_eq!(
        a.file_rows(),
        file_rows_at_kill,
        "the stopped session's file grew after the kill"
    );
    // The durable cancel + archived state held across the restart.
    assert_eq!(a.job_status().as_deref(), Some("cancelled"));
    assert_eq!(a.session_state(), "archived");
    drop(client);
    drop(supervisor);
}
