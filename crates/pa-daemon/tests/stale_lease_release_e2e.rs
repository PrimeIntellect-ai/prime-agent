//! The stale-lease-release e2e (the zombie-holder incident): a worker the
//! supervisor REVIVES at boot must stay supervised through the process it
//! spawned - never through the dead pre-restart pid its descriptor carried -
//! and the exhausted-failure give-up must release the session hold (no live
//! process of this daemon may outlive the abandoned id while holding the
//! session's runtime lease).
//!
//! The incident being pinned: a revived worker was alive and serving while
//! the monitor polled the dead pid the descriptor still named, counted six
//! phantom exits, gave up on the id, and left the live holder orphaned -
//! every create over the session file then refused with "This session is
//! currently open in another Rust build of Prime Agent (active in <id>)"
//! until the NEXT daemon restart's boot reap cleared the orphan. The
//! operator's sessions were unbootable in the meantime, and both advised
//! ways out were dead ends: no window existed to continue in (the daemon
//! had forgotten the holder), and the pid-kill advice asked the operator
//! to do the daemon's own cleanup by hand.
//!
//! The genuine refusals stay intact: a truly live foreign holder still
//! rejects (the hold_refusal e2e), and the create-reuse seam keeps
//! answering the live worker for every plain open (multi-client attach).
#![cfg(target_os = "linux")]

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

/// A supervisor with a LONG supervisor-lost window: an orphaned worker
/// must survive every other exit path so only the code under test can be
/// what stopped it (the harness default 15s window would let a worker
/// self-exit against a dead socket on its own).
// The timeout panic path cannot wait on the child; the test process exits
// immediately afterwards, reaping it.
#[allow(clippy::zombie_processes)]
fn spawn_supervisor(socket: &Path, agent_dir: &Path) -> Daemon {
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
            "600000",
        );
    let child = command.spawn().expect("spawn pa-daemon supervisor");
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if UnixStream::connect(socket).is_ok() {
            return Daemon {
                child,
                socket: socket.to_path_buf(),
            };
        }
        assert!(Instant::now() < deadline, "supervisor socket never came up");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Liveness that ignores zombies (a re-parented child nobody reaps keeps its
/// /proc entry until the status is collected).
fn process_alive(pid: u32) -> bool {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return false;
    };
    let Some((_, rest)) = stat.rsplit_once(')') else {
        return false;
    };
    let state = rest.split_whitespace().next().unwrap_or_default();
    !state.starts_with('Z') && !state.starts_with('X')
}

/// SIGKILL by pid (the tree's e2e pattern: the target is a worker process
/// the test does not own as a `std` child).
fn kill_hard(pid: u32) {
    let status = std::process::Command::new("kill")
        .arg("-9")
        .arg(pid.to_string())
        .status()
        .expect("run kill -9");
    assert!(status.success(), "kill -9 {pid} failed: {status}");
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
        fields.next();
        let Ok(parent) = fields.next().unwrap_or_default().parse::<u32>() else {
            continue;
        };
        if parent == ppid {
            pids.push(pid);
        }
    }
    pids
}

/// The daemon's rotating log for one socket (the incident's evidence file).
fn daemon_log(socket: &Path, agent_dir: &Path) -> PathBuf {
    pa_daemon::paths::daemon_log_path(socket, agent_dir)
}

fn log_contains(socket: &Path, agent_dir: &Path, needle: &str) -> bool {
    std::fs::read_to_string(daemon_log(socket, agent_dir))
        .map(|log| log.contains(needle))
        .unwrap_or(false)
}

/// Wait until the daemon log names `needle`, or panic past `budget`.
fn await_log_line(socket: &Path, agent_dir: &Path, needle: &str, budget: Duration) {
    let deadline = Instant::now() + budget;
    while !log_contains(socket, agent_dir, needle) {
        assert!(
            Instant::now() < deadline,
            "the daemon log never said \"{needle}\""
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Wait `budget` for the log to STOP gaining `needle` (the give-up storm
/// window: a fixed sleep makes the test observe the failure cascade
/// without depending on its exact pacing).
fn log_settles_without(socket: &Path, agent_dir: &Path, needle: &str, budget: Duration) {
    std::thread::sleep(budget);
    assert!(
        !log_contains(socket, agent_dir, needle),
        "the daemon log recorded \"{needle}\""
    );
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
        let deadline = Instant::now() + Duration::from_secs(30);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
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

    fn read_response(&mut self, id: &str) -> Value {
        loop {
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }
}

fn write_script(dir: &Path, name: &str, responses: &[&str]) -> PathBuf {
    let script_path = dir.join(name);
    let scripted: Vec<Value> = responses
        .iter()
        .map(|text| json!({ "text": text, "delayMs": 10 }))
        .collect();
    std::fs::write(&script_path, json!({ "responses": scripted }).to_string()).expect("write");
    script_path
}

/// One scripted session: create + attach, returning the active session id
/// (the worker id), its durable file, and the live worker pid.
fn create_session(
    client: &mut Client,
    dir: &Path,
    sessions_dir: &Path,
    supervisor_pid: u32,
) -> (String, u32) {
    let script_path = write_script(dir, "script.json", &["turn-1"]);
    client.send_command(
        "c1",
        json!({
            "type": "create",
            "config": {
                "cwd": dir.to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
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
    client.send_command(
        "a1",
        json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let attached = client.read_response("a1");
    assert_eq!(attached["success"], true, "attach failed");
    let deadline = Instant::now() + Duration::from_secs(10);
    let worker_pid = loop {
        let alive = child_pids_of(supervisor_pid)
            .into_iter()
            .filter(|pid| process_alive(*pid))
            .collect::<Vec<_>>();
        if !alive.is_empty() {
            break alive[0];
        }
        assert!(Instant::now() < deadline, "worker never spawned");
        std::thread::sleep(Duration::from_millis(50));
    };
    (session_id, worker_pid)
}

/// The worker descriptor path for one session on one socket.
fn descriptor_path(agent_dir: &Path, socket: &Path, session_id: &str) -> PathBuf {
    pa_daemon::descriptor::descriptor_dir(agent_dir, socket).join(format!("{session_id}.json"))
}

/// One session's durable file path, from its worker descriptor (the create
/// response's `id` is the ACTIVE session id; the file on disk is named by
/// the durable session UUID).
fn session_file_of(agent_dir: &Path, socket: &Path, session_id: &str) -> PathBuf {
    let descriptor = std::fs::read_to_string(descriptor_path(agent_dir, socket, session_id))
        .expect("descriptor");
    let descriptor: Value = serde_json::from_str(&descriptor).expect("parse descriptor");
    PathBuf::from(
        descriptor
            .get("sessionFile")
            .and_then(Value::as_str)
            .expect("the descriptor names its session file"),
    )
}

/// The worker's own socket path from its descriptor (every relaunched
/// epoch of one id binds the same path).
fn worker_socket_of(agent_dir: &Path, socket: &Path, session_id: &str) -> PathBuf {
    let descriptor = std::fs::read_to_string(descriptor_path(agent_dir, socket, session_id))
        .expect("descriptor");
    let descriptor: Value = serde_json::from_str(&descriptor).expect("parse descriptor");
    PathBuf::from(
        descriptor
            .get("socketPath")
            .and_then(Value::as_str)
            .expect("the descriptor names its worker socket"),
    )
}

/// Whether the worker's socket is serving: a relaunched worker counts as
/// up only once its endpoint accepts connections. A kill fired mid-boot
/// would burn the daemon's whole 30s connect budget per cycle (the probe
/// waits out a socket that never comes up), so the crash loop paces its
/// kills on this probe instead.
fn worker_serving(socket_path: &Path) -> bool {
    UnixStream::connect(socket_path).is_ok()
}

/// The operator's open: a create that targets an existing session file.
fn open_session_command(
    id: &str,
    session_file: &Path,
    dir: &Path,
    sessions_dir: &Path,
    script: &Path,
) -> (String, Value) {
    (
        id.to_string(),
        json!({
            "type": "create",
            "sessionPath": session_file.to_string_lossy(),
            "config": {
                "cwd": dir.to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
                "script": script.to_string_lossy(),
            },
        }),
    )
}

/// The incident's precondition, end to end: a supervisor dies (kill -9)
/// leaving its worker alive with a fresh `busy` journal record (the
/// create's - only a hard kill skips the settle), then the worker dies the
/// same way. The next boot finds a dead worker with interrupted-work
/// evidence: the boot-revival path's exact entry.
fn crash_daemon_and_worker(daemon: &mut Daemon, worker_pid: u32) {
    daemon.child.kill().expect("kill -9 supervisor");
    let _ = daemon.child.wait();
    kill_hard(worker_pid);
    let deadline = Instant::now() + Duration::from_secs(10);
    while process_alive(worker_pid) {
        assert!(Instant::now() < deadline, "worker survived kill -9");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The zombie-holder incident, end to end: a daemon dies with its worker
/// mid-flight, a new daemon boots on the SAME socket and revives the dead
/// worker - and the revived worker must stay supervised through the
/// process the revival spawned. The buggy monitor watched the descriptor's
/// dead pre-restart pid instead: the first poll read as a phantom exit,
/// the failure loop spawned duplicates until the cap gave up on the id,
/// and the healthy revived worker was left orphaned - alive, holding the
/// session's runtime lease, forgotten by the registry, refusing every
/// create for the file with the "already active in <id>" hold refusal.
#[test]
fn the_revived_worker_stays_supervised_and_the_session_reopens() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");

    let mut daemon = spawn_supervisor(&socket, &agent_dir);
    let supervisor_pid = daemon.child.id();
    let mut client = Client::connect(&socket);
    let (session_id, worker_pid) =
        create_session(&mut client, dir.path(), &sessions_dir, supervisor_pid);
    let session_file = session_file_of(&agent_dir, &socket, &session_id);

    crash_daemon_and_worker(&mut daemon, worker_pid);

    // The new daemon on the SAME socket: its adoption revives the dead
    // worker (journal-proven interrupted work, fresh).
    let _daemon2 = spawn_supervisor(&socket, &agent_dir);
    await_log_line(
        &socket,
        &agent_dir,
        &format!("adopted session worker {session_id} (was alive: false)"),
        Duration::from_secs(20),
    );

    // The give-up storm window: the buggy monitor's phantom failures ran
    // the whole backoff ladder (0.25+0.5+1+2+4s plus restarts) inside
    // this budget; a supervised revival logs nothing of the kind.
    log_settles_without(
        &socket,
        &agent_dir,
        "failed after 6 consecutive failures",
        Duration::from_secs(12),
    );
    log_settles_without(
        &socket,
        &agent_dir,
        "exited unexpectedly",
        Duration::from_millis(200),
    );

    // The operator's open: the session file the revived worker serves.
    // The reuse seam answers the live binding (multi-client attach); the
    // buggy tree answered the zombie-holder refusal instead.
    let reopen_script = write_script(dir.path(), "script-reopen.json", &["turn-reopen"]);
    let mut client2 = Client::connect(&socket);
    let (reopen_id, reopen_command) = open_session_command(
        "reopen",
        &session_file,
        dir.path(),
        &sessions_dir,
        &reopen_script,
    );
    client2.send_command(&reopen_id, reopen_command);
    let reopened = client2.read_response(&reopen_id);
    assert_eq!(
        reopened["success"], true,
        "the session must reopen after the revival (the operator's flow): {reopened}"
    );
}

/// The exhausted-failure state releases the session hold: a worker that
/// genuinely crash-loops to the give-up cap leaves the session re-openable
/// through the very next client create - no refusal, no manual pid kill.
#[test]
fn a_worker_that_fails_to_death_releases_the_session_hold() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");

    let daemon = spawn_supervisor(&socket, &agent_dir);
    let supervisor_pid = daemon.child.id();
    let mut client = Client::connect(&socket);
    let (session_id, _worker_pid) =
        create_session(&mut client, dir.path(), &sessions_dir, supervisor_pid);
    let session_file = session_file_of(&agent_dir, &socket, &session_id);

    // The crash loop: kill the worker every time it comes back up, until
    // the supervisor exhausts the cap (each death is real, each relaunch
    // reclaims the dead holder's stale lease, and the cap gives up on the
    // id). A kill must land AFTER the relaunch's create replay settles
    // (the replay's re-registration lands ~1s after the socket binds):
    // a worker dying mid-replay parks the relaunch until the create
    // route's own 600s budget instead of the backoff ladder, and the
    // failure counter never climbs. The pace is a serving grace: the
    // worker's socket must have served continuously for the grace before
    // the kill fires.
    let worker_socket = worker_socket_of(&agent_dir, &socket, &session_id);
    let give_up = format!("session worker {session_id} failed after 6 consecutive failures");
    let replay_grace = Duration::from_secs(4);
    let mut serving_since: Option<Instant> = None;
    let deadline = Instant::now() + Duration::from_mins(3);
    while !log_contains(&socket, &agent_dir, &give_up) {
        let alive = child_pids_of(supervisor_pid)
            .into_iter()
            .filter(|pid| process_alive(*pid))
            .collect::<Vec<_>>();
        if worker_serving(&worker_socket) {
            let ready = serving_since.get_or_insert(Instant::now()).elapsed() >= replay_grace;
            if let (Some(worker), true) = (alive.first(), ready) {
                kill_hard(*worker);
            }
        } else {
            serving_since = None;
        }
        assert!(
            Instant::now() < deadline,
            "the supervisor never gave up on the crash loop"
        );
        std::thread::sleep(Duration::from_millis(200));
    }

    // The give-up settles before the sweep and the reopen run: the log
    // names the verdict, then (with nothing live left of the id) nothing
    // further - the session file is free for the next open.
    std::thread::sleep(Duration::from_secs(2));

    // The operator's reopen: no resident serves the file (the id was
    // abandoned), so this is a fresh launch over the freed hold. The dead
    // holder's lease self-heals through the stale-owner reclaim; a live
    // leftover would bounce this create with the hold refusal.
    let reopen_script = write_script(dir.path(), "script-reopen.json", &["turn-reopen"]);
    let mut client2 = Client::connect(&socket);
    let (reopen_id, reopen_command) = open_session_command(
        "reopen",
        &session_file,
        dir.path(),
        &sessions_dir,
        &reopen_script,
    );
    client2.send_command(&reopen_id, reopen_command);
    let reopened = client2.read_response(&reopen_id);
    assert_eq!(
        reopened["success"], true,
        "a given-up worker must leave its session re-openable: {reopened}"
    );
}

/// The give-up belt: when the supervisor abandons a worker id, no live
/// process of this daemon may keep carrying that id - a leftover holding
/// the abandoned identity is reaped identity-gated at the give-up, so the
/// id (and the session hold its processes took) actually releases.
#[test]
fn the_give_up_sweep_reaps_a_live_leftover_of_the_abandoned_id() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");

    let daemon = spawn_supervisor(&socket, &agent_dir);
    let supervisor_pid = daemon.child.id();
    let mut client = Client::connect(&socket);
    let (session_id, worker_pid) =
        create_session(&mut client, dir.path(), &sessions_dir, supervisor_pid);

    // A leftover of the id: a real product worker process (the binary's
    // `worker` role, the exact argv and env shape the supervisor stamps)
    // whose active-session env names the session's worker id. It fails
    // registration (an unknown token) and parks in the registration
    // backoff - the shape of a process the supervisor lost track of.
    let mut fake = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("worker")
        .env(pa_daemon::worker::WORKER_ROLE_ENV, "1")
        .env(pa_daemon::worker::WORKER_ACTIVE_SESSION_ID_ENV, &session_id)
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_SOCKET_ENV,
            socket.to_string_lossy().to_string(),
        )
        .env(
            pa_daemon::worker::WORKER_SOCKET_ENV,
            dir.path()
                .join("fake-worker.sock")
                .to_string_lossy()
                .to_string(),
        )
        .env(pa_daemon::worker::WORKER_TOKEN_ENV, "not-the-real-token")
        .env(pa_daemon::worker::WORKER_INSTANCE_ID_ENV, "fake-instance")
        .env(
            pa_daemon::worker::WORKER_RECOVERY_JOURNAL_ENV,
            dir.path()
                .join("fake-recovery.jsonl")
                .to_string_lossy()
                .to_string(),
        )
        .env(
            pa_daemon::worker::WORKER_CWD_ENV,
            dir.path().to_string_lossy().to_string(),
        )
        .env(
            pa_daemon::paths::AGENT_DIR_ENV,
            agent_dir.to_string_lossy().to_string(),
        )
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn the leftover worker role");
    let fake_pid = fake.id();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !process_alive(fake_pid) {
        assert!(
            Instant::now() < deadline,
            "the leftover worker role never came up"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    // Set apart from the supervisor's own children: the leftover is not
    // the live session worker.
    assert!(
        !child_pids_of(supervisor_pid).contains(&fake_pid),
        "the leftover must not be a child the supervisor watches"
    );

    // The crash loop to the give-up cap: the sweep runs with the verdict
    // and must take the leftover down with the abandoned id. Kills pace
    // on a serving grace past the replay window (a mid-replay death
    // parks the relaunch on the create route's own budget - see the
    // fails-to-death test).
    let worker_socket = worker_socket_of(&agent_dir, &socket, &session_id);
    kill_hard(worker_pid);
    let give_up = format!("session worker {session_id} failed after 6 consecutive failures");
    let replay_grace = Duration::from_secs(4);
    let mut serving_since: Option<Instant> = None;
    let deadline = Instant::now() + Duration::from_mins(3);
    while !log_contains(&socket, &agent_dir, &give_up) {
        let alive = child_pids_of(supervisor_pid)
            .into_iter()
            .filter(|pid| process_alive(*pid))
            .collect::<Vec<_>>();
        if worker_serving(&worker_socket) {
            let ready = serving_since.get_or_insert(Instant::now()).elapsed() >= replay_grace;
            if let (Some(worker), true) = (alive.first(), ready) {
                kill_hard(*worker);
            }
        } else {
            serving_since = None;
        }
        assert!(
            Instant::now() < deadline,
            "the supervisor never gave up on the crash loop"
        );
        std::thread::sleep(Duration::from_millis(200));
    }
    await_log_line(
        &socket,
        &agent_dir,
        &format!("give-up sweep: leftover worker pid {fake_pid}"),
        Duration::from_secs(10),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while process_alive(fake_pid) {
        assert!(
            Instant::now() < deadline,
            "the leftover of the abandoned id survived the give-up sweep"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = fake.wait();
}
