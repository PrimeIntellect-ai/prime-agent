//! The stranded-worker registration heal e2e: a session worker whose
//! supervisor destroyed its durable identity (its descriptor is gone) is
//! the live-box incident's leftover holder — alive, holding its runtime
//! session lease, and invisible to every roster: its registration is
//! refused with the TS unknown-worker error, nothing on the daemon can
//! adopt or route to it, and the orphan-exit monitor never fires because
//! the (new) supervisor socket answers. The refused-registration
//! self-heal retires the worker — the graceful close a routed `shutdown`
//! runs — so the lease releases and the session file resumes; the
//! per-session stop retires the descriptor only after a confirmed
//! process death (the same contract the shutdown pass enforces), so a
//! stop that misses its worker escalates instead of stranding it.
// The suite's liveness and child-discovery helpers read Linux procfs;
// on other unixes they cannot observe processes, and the waits would
// pass vacuously — skip the suite there instead of reporting a false
// green.
#![cfg(all(unix, target_os = "linux"))]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

struct Daemon {
    child: Child,
    // The socket path rides the struct for harness symmetry (the spawned
    // daemon's address is part of the fixture); no case reads it here.
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
fn spawn_daemon(socket: &Path, agent_dir: &Path) -> Daemon {
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
    let child = command.spawn().expect("spawn pa-daemon supervisor");
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if UnixStream::connect(socket).is_ok() {
            return Daemon {
                child,
                socket: socket.to_path_buf(),
            };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("supervisor socket never came up");
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
        let deadline = Instant::now() + Duration::from_secs(70);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if !line.trim().is_empty() => {
                    return serde_json::from_str(line.trim()).expect("parse response line");
                }
                Ok(_) => {}
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
        let deadline = Instant::now() + Duration::from_secs(70);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(|value| value.as_str()) == Some(id) {
                return line;
            }
        }
    }
}

fn write_script(dir: &Path, responses: &[&str]) -> PathBuf {
    let script_path = dir.join(format!("script-{}.json", std::process::id()));
    let scripted: Vec<Value> = responses
        .iter()
        .map(|text| json!({ "text": text }))
        .collect();
    std::fs::write(&script_path, json!({ "responses": scripted }).to_string())
        .expect("write script");
    script_path
}

/// Liveness that ignores zombies (a re-parented child nobody reaps keeps
/// its /proc entry until the status is collected).
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

/// Pids whose parent is `ppid` (the supervisor's worker children).
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

/// Wait until the pid is gone or the deadline passes.
fn wait_gone(pid: u32, deadline: Instant) -> bool {
    while process_alive(pid) {
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    true
}

/// End a possibly-stopped worker by force (SIGKILL reaches a stopped
/// process; SIGTERM does not deliver while it is stopped).
fn force_kill(pid: u32) {
    let _ = Command::new("kill").arg("-9").arg(pid.to_string()).status();
}

/// The one worker child of `daemon_pid`, awaited within a bounded window.
fn the_one_worker_of(daemon_pid: u32) -> u32 {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let children = child_pids_of(daemon_pid);
        if children.len() == 1 {
            return children[0];
        }
        assert!(
            Instant::now() < deadline,
            "the session worker never spawned (children: {children:?})"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
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

/// Run one scripted turn to completion so the worker sits idle holding its
/// session lease (the create reply alone is enough for the lease, but the
/// completed turn makes the file a real transcript).
fn run_one_turn(client: &mut Client, id: &str, request_id: &str) {
    client.send_command(
        request_id,
        json!({
            "type": "prompt_and_wait",
            "activeSessionId": id,
            "message": "go",
        }),
    );
    let done = client.read_response(request_id);
    assert_eq!(done["success"], true, "scripted turn failed: {done}");
}

/// A refused registration retires the worker: a supervisor that holds no
/// descriptor for the identity answers `worker_register` with the
/// unknown-worker error, and the worker — which before the self-heal
/// retried forever, holding whatever it held with no daemon able to reach
/// it — runs its graceful close and exits instead. The refusal is also
/// observable: the daemon logs it (the box incident left it silent) and
/// emits its `daemon event`.
#[test]
fn a_refused_registration_retires_the_worker() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(agent_dir.join("sessions")).expect("sessions dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);

    // A bare worker with an identity no descriptor backs: the supervisor
    // can only refuse it. The scripted engine keeps the worker's runtime
    // self-contained (no model resolution, no kernel) so the retire path
    // under test is the registration close alone.
    let script_path = write_script(dir.path(), &["unused"]);
    let mut worker = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("worker")
        .env(pa_daemon::worker::WORKER_ROLE_ENV, "1")
        .env(pa_daemon::worker::WORKER_TOKEN_ENV, "token-no-descriptor")
        .env(pa_daemon::worker::WORKER_INSTANCE_ID_ENV, "instance-orphan")
        .env(
            pa_daemon::worker::WORKER_ACTIVE_SESSION_ID_ENV,
            "orphan000001",
        )
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_SOCKET_ENV,
            socket.to_string_lossy().to_string(),
        )
        .env(
            pa_daemon::worker::WORKER_SOCKET_ENV,
            dir.path().join("orphan.sock").to_string_lossy().to_string(),
        )
        .env(
            pa_daemon::worker::WORKER_RECOVERY_JOURNAL_ENV,
            dir.path()
                .join("orphan.recovery.jsonl")
                .to_string_lossy()
                .to_string(),
        )
        .env(
            pa_daemon::worker::WORKER_SCRIPT_ENV,
            script_path.to_string_lossy().to_string(),
        )
        .env(
            pa_daemon::paths::AGENT_DIR_ENV,
            agent_dir.to_string_lossy().to_string(),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn worker");
    let worker_pid = worker.id();

    // The refusal lands in the daemon's rotating log (the operator-facing
    // trace the incident lacked) — and the worker exits instead of
    // retrying forever.
    let log_path = pa_daemon::paths::daemon_log_path(&socket, &agent_dir);
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        if log.contains("orphan000001 registration refused") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the refused registration never reached the log: {log}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    if !wait_gone(worker_pid, Instant::now() + Duration::from_secs(15)) {
        force_kill(worker_pid);
        let _ = worker.wait();
        panic!("the refused worker never retired (it must run its graceful close and exit)");
    }
    let _ = worker.wait();

    // The refusal leaves the worker's own socket behind it: a graceful
    // exit owns its endpoint file.
    assert!(
        !dir.path().join("orphan.sock").exists(),
        "the retired worker cleaned up its own socket"
    );
    let _ = std::fs::remove_file(dir.path().join("orphan.sock"));
}

/// The box incident, end to end: a supervisor dies over a live worker,
/// the worker's descriptor is destroyed (the pre-reap stop pass's exact
/// on-disk state), and the next daemon cycle must not leave the worker
/// as an invisible lease holder — it dies (the self-heal retires it
/// wherever the boot reap cannot enumerate processes), the lease
/// releases, and the session file resumes through a fresh registered
/// worker: the create over the held file succeeds instead of answering
/// the "session is currently open in another Rust build" refusal.
#[test]
fn a_descriptorless_leftover_dies_and_its_session_resumes() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");

    let mut daemon = spawn_daemon(&socket, &agent_dir);
    let daemon_pid = daemon.child.id();
    let mut client = Client::connect(&socket);
    let script_path = write_script(dir.path(), &["first scripted", "resumed turn"]);
    let create_config = json!({
        "cwd": dir.path().to_string_lossy(),
        "sessionDir": sessions_dir.to_string_lossy(),
        "script": script_path.to_string_lossy(),
    });
    let (worker_id, _created) = create_session(&mut client, "c1", &create_config);
    run_one_turn(&mut client, &worker_id, "p1");
    let session_file = session_file_of(&mut client, &worker_id, "s1");
    let worker_pid = the_one_worker_of(daemon_pid);

    // The supervisor dies hard; the detached worker survives it, holding
    // its session lease. Its descriptor is then destroyed — the stranded
    // state the incident left on disk (and the state a raced terminal
    // stop produced before the confirm-then-delete contract).
    drop(client);
    let _ = daemon.child.kill();
    let _ = daemon.child.wait();
    drop(daemon);
    assert!(
        process_alive(worker_pid),
        "the worker survived its supervisor's hard death"
    );
    let descriptor_dir = pa_daemon::descriptor::descriptor_dir(&agent_dir, &socket);
    let descriptor = std::fs::read_dir(&descriptor_dir)
        .expect("descriptor dir")
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            let name = path.file_name().map(|name| name.to_string_lossy().to_string());
            matches!(&name, Some(name) if name.ends_with(".json") && !name.ends_with(".recovery.jsonl"))
        })
        .expect("the worker's descriptor is on disk");
    std::fs::remove_file(&descriptor).expect("destroy the descriptor");

    // The next daemon cycle: the leftover worker's re-registration is
    // refused (no descriptor), so it retires (or, where the boot reap can
    // enumerate processes, the reap clears it — the end state is the
    // same); the lease releases and the session file resumes through a
    // fresh registered worker.
    let daemon2 = spawn_daemon(&socket, &agent_dir);
    if !wait_gone(worker_pid, Instant::now() + Duration::from_secs(20)) {
        force_kill(worker_pid);
        panic!("the descriptorless leftover worker survived the next daemon cycle (the registration heal or the boot reap must clear it)");
    }

    let mut client = Client::connect(&socket);
    client.send_command(
        "r1",
        json!({
            "type": "create",
            "sessionPath": session_file,
            "config": create_config,
        }),
    );
    let resumed = client.read_response("r1");
    assert_eq!(
        resumed["success"], true,
        "the resumed create must succeed (no hold refusal): {resumed}"
    );
    let resumed_id = resumed["data"]["id"]
        .as_str()
        .or_else(|| resumed["data"]["sessionId"].as_str())
        .expect("resumed session id")
        .to_string();
    run_one_turn(&mut client, &resumed_id, "p2");

    // Teardown: the resumed worker dies with the daemon, never leaking
    // into later test binaries.
    let _ = client.writer.shutdown(std::net::Shutdown::Both);
    for pid in child_pids_of(daemon2.child.id()) {
        let _ = Command::new("kill").arg("-9").arg(pid.to_string()).status();
    }
    drop(daemon2);
}

/// A stop whose worker misses the routed `shutdown` must not strand it:
/// the per-session stop shares the terminal-stop contract — the
/// descriptor dies only with a provably-gone process, and a live worker
/// gets the SIGTERM -> SIGKILL escalation instead of an invisible
/// lease-holder's life sentence.
#[test]
fn an_owned_stop_kills_a_worker_that_missed_the_shutdown() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");

    let daemon = spawn_daemon(&socket, &agent_dir);
    let daemon_pid = daemon.child.id();
    let mut client = Client::connect(&socket);
    let script_path = write_script(dir.path(), &["first scripted", "resumed turn"]);
    let create_config = json!({
        "cwd": dir.path().to_string_lossy(),
        "sessionDir": sessions_dir.to_string_lossy(),
        "script": script_path.to_string_lossy(),
    });
    // A client-owned session: its owner's stop is the per-session stop
    // that must escalate past a wedged worker.
    client.send_command(
        "c1",
        json!({
            "type": "create",
            "lifecycle": "client_owned",
            "config": create_config,
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let worker_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id in create response")
        .to_string();
    run_one_turn(&mut client, &worker_id, "p1");
    let session_file = session_file_of(&mut client, &worker_id, "s1");
    let worker_pid = the_one_worker_of(daemon_pid);

    // The worker freezes mid-flight: it cannot process the routed
    // shutdown (the route times out), it survives SIGTERM (the signal
    // stays pending while it is stopped), and only SIGKILL ends it.
    let stop = Command::new("kill")
        .arg("-STOP")
        .arg(worker_pid.to_string())
        .status()
        .expect("SIGSTOP the worker");
    assert!(stop.success(), "SIGSTOP the session worker");

    // The owner stops its session: the stop must confirm the worker's
    // process death (escalating to SIGKILL) before retiring its
    // descriptor. The response waits out the whole stop.
    client.send_command(
        "k1",
        json!({ "type": "complete_owned_session", "activeSessionId": worker_id }),
    );
    // The stop's durable intent is observable on disk BEFORE the worker
    // is told: the routed shutdown waits out its route budget against the
    // frozen worker, and in that window the descriptor must already carry
    // its stop tombstone — a supervisor that died mid-stop would adopt
    // the tombstone (finishing the stop) instead of the worker (a later
    // boot must never re-adopt a stopped worker as healthy).
    let descriptor_path = pa_daemon::descriptor::descriptor_dir(&agent_dir, &socket)
        .join(format!("{worker_id}.json"));
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let descriptor: Value =
            serde_json::from_str(&std::fs::read_to_string(&descriptor_path).unwrap_or_default())
                .unwrap_or(Value::Null);
        let marker = descriptor
            .get("stopRequestedAt")
            .and_then(Value::as_str)
            .is_some_and(|requested| !requested.is_empty())
            && descriptor.get("archiveOnStop") == Some(&Value::Bool(false));
        if marker {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the owned stop never persisted its tombstone (the stop must be durable before the shutdown routes): {descriptor}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    let stopped = client.read_response("k1");
    assert_eq!(stopped["success"], true, "owned stop failed: {stopped}");
    if !wait_gone(worker_pid, Instant::now() + Duration::from_secs(5)) {
        force_kill(worker_pid);
        panic!("the stopped worker outlived its stop — the per-session stop must escalate (SIGKILL) instead of stranding a live lease holder");
    }

    // The frozen worker's lease released with its death: the session file
    // opens again instead of answering the hold refusal.
    client.send_command(
        "r1",
        json!({
            "type": "create",
            "sessionPath": session_file,
            "config": create_config,
        }),
    );
    let resumed = client.read_response("r1");
    assert_eq!(
        resumed["success"], true,
        "the stopped-then-killed session must resume: {resumed}"
    );
    let resumed_id = resumed["data"]["id"]
        .as_str()
        .or_else(|| resumed["data"]["sessionId"].as_str())
        .expect("resumed session id")
        .to_string();
    run_one_turn(&mut client, &resumed_id, "p2");

    // Teardown: the resumed worker dies with the daemon.
    let _ = client.writer.shutdown(std::net::Shutdown::Both);
    for pid in child_pids_of(daemon.child.id()) {
        let _ = Command::new("kill").arg("-9").arg(pid.to_string()).status();
    }
    drop(daemon);
}
