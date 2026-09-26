//! End-to-end fd-lifecycle audit against the real `pa-daemon` supervisor:
//! spawn the supervisor, run create/prompt/kill session cycles, and sample
//! `/proc/<pid>/fd` per cycle so any monotonically growing fd class in the
//! supervisor (worker transports, journals, logs, event channels) is
//! caught as a regression.
#![cfg(unix)]

use std::collections::HashMap;
use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Sample the open-fd set of a process: count plus one readlink target per
/// fd. Returns an empty snapshot for a dead pid.
fn fd_snapshot(pid: u32) -> Vec<String> {
    let dir = PathBuf::from(format!("/proc/{pid}/fd"));
    let mut targets = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return targets;
    };
    for entry in entries.flatten() {
        let target = std::fs::read_link(entry.path())
            .map_or_else(|_| "?".to_string(), |t| t.to_string_lossy().to_string());
        targets.push(target);
    }
    targets
}

/// Histogram of fd readlink targets (socket inodes collapse to a class).
fn fd_classes(targets: &[String]) -> Vec<(String, usize)> {
    let mut classes: HashMap<String, usize> = HashMap::new();
    for target in targets {
        let class = if target.starts_with("socket:") {
            "socket".to_string()
        } else if target.starts_with("pipe:") {
            "pipe".to_string()
        } else if target.starts_with("/memfd:") {
            "memfd".to_string()
        } else if target.starts_with("/dev/") {
            "device".to_string()
        } else {
            "file".to_string()
        };
        *classes.entry(class).or_default() += 1;
    }
    let mut rows: Vec<(String, usize)> = classes.into_iter().collect();
    rows.sort();
    rows
}

struct Daemon {
    child: Child,
    #[expect(dead_code)]
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
    let binary = env!("CARGO_BIN_EXE_pa-daemon");
    let child = Command::new(binary)
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
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
    fn connect(socket: &Path) -> (Self, serde_json::Value) {
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
        (client, hello)
    }

    fn send_command(&mut self, id: &str, command: serde_json::Value) {
        let envelope = serde_json::json!({
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

    fn read_line(&mut self) -> serde_json::Value {
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_secs(15);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => {}
                Ok(_) => return serde_json::from_str(line.trim()).expect("parse response line"),
                Err(error) => {
                    assert!(
                        Instant::now() < deadline,
                        "timed out waiting for supervisor line: {error}"
                    );
                }
            }
        }
    }

    fn read_response(&mut self, id: &str) -> serde_json::Value {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(|v| v.as_str()) == Some(id) {
                return line;
            }
        }
    }
}

/// The worker pid for a session, from the supervisor's persisted descriptor.
fn worker_pid(agent_dir: &Path, socket_path: &Path, worker_id: &str) -> Option<u32> {
    use sha2::Digest as _;
    let digest = sha2::Sha256::digest(socket_path.to_string_lossy().as_bytes());
    let mut hex = String::new();
    for byte in &digest {
        write!(hex, "{byte:02x}").expect("write to String");
    }
    let descriptor_dir = agent_dir.join("daemon-workers").join(&hex[..12]);
    let descriptor: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(descriptor_dir.join(format!("{worker_id}.json"))).ok()?,
    )
    .ok()?;
    descriptor
        .get("pid")
        .and_then(serde_json::Value::as_u64)
        .map(|p| p as u32)
}

fn wait_until(deadline: Duration, mut probe: impl FnMut() -> bool) {
    let deadline = Instant::now() + deadline;
    while Instant::now() < deadline {
        if probe() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("condition not reached within {deadline:?}");
}

const CYCLES: usize = 20;
/// fds that may legitimately sit open on top of the steady state: the test
/// client's own connection plus short-lived inflight work.
const FD_SLACK: usize = 6;

/// The fd regression test: across a create/prompt/kill cycle set, the
/// supervisor's open-fd count must stay at its steady baseline (its client
/// connection, one transport per live worker, the listener, and files).
/// A monotonically growing fd class here is an EMFILE factory under the
/// supervisor's restart loops.
#[test]
fn supervisor_fd_count_stable_across_session_cycles() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let daemon = spawn_daemon(&socket, &agent_dir);
    let supervisor_pid = daemon.child.id();
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        serde_json::json!({ "responses": [ { "text": "cycled" } ] }).to_string(),
    )
    .expect("write script");

    // Warm-up cycle: the first launch may populate lazy caches (provider
    // registries, journal files); the steady-state baseline is what the
    // cycle set must hold.
    let mut counts: Vec<usize> = Vec::new();
    for cycle in 0..=CYCLES {
        let create_id = format!("c{cycle}");
        client.send_command(
            &create_id,
            serde_json::json!({
                "type": "create",
                "config": {
                    "cwd": dir.path().to_string_lossy(),
                    "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                    "script": script_path.to_string_lossy(),
                },
            }),
        );
        let created = client.read_response(&create_id);
        assert_eq!(created["success"], true, "create failed: {created}");
        let session_id = created["data"]["id"]
            .as_str()
            .or_else(|| created["data"]["sessionId"].as_str())
            .expect("session id")
            .to_string();
        let pid = worker_pid(&agent_dir, &socket, &session_id).expect("worker pid from descriptor");
        assert_ne!(pid, supervisor_pid);

        client.send_command(
            &format!("a{cycle}"),
            serde_json::json!({ "type": "attach", "activeSessionId": session_id }),
        );
        assert_eq!(
            client.read_response(&format!("a{cycle}"))["success"],
            true,
            "attach failed"
        );
        client.send_command(
            &format!("p{cycle}"),
            serde_json::json!({
                "type": "prompt_and_wait",
                "activeSessionId": session_id,
                "message": "cycle",
            }),
        );
        let prompt = client.read_response(&format!("p{cycle}"));
        assert_eq!(prompt["success"], true, "prompt failed: {prompt}");

        // While the worker is alive, record its own fd count too: a
        // per-session worker leak shows up here before the supervisor's.
        let worker_fds = fd_snapshot(pid);
        if cycle % 5 == 0 {
            println!(
                "cycle {cycle}: worker pid {pid} open fds {} ({:?})",
                worker_fds.len(),
                fd_classes(&worker_fds)
            );
        }

        client.send_command(
            &format!("k{cycle}"),
            serde_json::json!({ "type": "kill", "activeSessionId": session_id }),
        );
        let killed = client.read_response(&format!("k{cycle}"));
        assert_eq!(killed["success"], true, "kill failed: {killed}");

        // The kill settles asynchronously: the worker process exits and the
        // roster/list drops the row. Only sample the supervisor once both
        // are observed, so a slow reap cannot fake stability.
        wait_until(Duration::from_secs(10), || {
            fd_snapshot(pid).is_empty() || worker_pid(&agent_dir, &socket, &session_id).is_none()
        });
        wait_until(Duration::from_secs(10), || {
            client.send_command("l", serde_json::json!({ "type": "list" }));
            let list = client.read_response("l");
            list["data"]["sessions"]
                .as_array()
                .is_some_and(std::vec::Vec::is_empty)
        });

        let targets = fd_snapshot(supervisor_pid);
        println!(
            "cycle {cycle}: supervisor open fds {} ({:?})",
            targets.len(),
            fd_classes(&targets)
        );
        if !targets.is_empty() {
            counts.push(targets.len());
        }
    }

    // Baseline: the steady state after the warm-up cycle.
    let baseline = counts[0];
    for (index, count) in counts.iter().enumerate() {
        assert!(
            *count <= baseline + FD_SLACK,
            "supervisor fd count grew across cycles: baseline {baseline}, \
             cycle {index} count {count} ({:?} at cycle {index})",
            fd_classes(&fd_snapshot(supervisor_pid))
        );
    }
    assert!(
        counts.last().copied().unwrap_or_default() >= 3,
        "fd sampling looked broken (no fds observed)"
    );
}

/// Per-turn fd stability inside one long-lived worker: the owner-facing
/// symptom is a worker slowly filling its fd table across turns, then
/// crashing with EMFILE into the supervisor's restart loop. Sample the
/// worker's fds across many prompts on the same session.
#[test]
fn worker_fd_count_stable_across_prompts() {
    const PROMPTS: usize = 30;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let daemon = spawn_daemon(&socket, &agent_dir);
    let supervisor_pid = daemon.child.id();
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        serde_json::json!({ "responses": [
            { "text": "turn answer" },
            { "text": "turn answer" },
            { "text": "turn answer" },
            { "text": "turn answer" },
            { "text": "turn answer" },
            { "text": "turn answer" },
            { "text": "turn answer" },
            { "text": "turn answer" },
            { "text": "turn answer" },
            { "text": "turn answer" },
        ] })
        .to_string(),
    )
    .expect("write script");

    client.send_command(
        "c0",
        serde_json::json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("c0");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();
    let pid = worker_pid(&agent_dir, &socket, &session_id).expect("worker pid");
    client.send_command(
        "a0",
        serde_json::json!({ "type": "attach", "activeSessionId": session_id }),
    );
    assert_eq!(client.read_response("a0")["success"], true, "attach failed");

    let mut counts: Vec<usize> = Vec::new();
    for turn in 0..PROMPTS {
        let id = format!("p{turn}");
        client.send_command(
            &id,
            serde_json::json!({
                "type": "prompt_and_wait",
                "activeSessionId": session_id,
                "message": format!("turn {turn}"),
            }),
        );
        let prompt = client.read_response(&id);
        assert_eq!(prompt["success"], true, "prompt failed: {prompt}");
        if turn % 5 == 0 {
            let worker_fds = fd_snapshot(pid);
            let supervisor_fds = fd_snapshot(supervisor_pid);
            println!(
                "turn {turn}: worker fds {} ({:?}), supervisor fds {}",
                worker_fds.len(),
                fd_classes(&worker_fds),
                supervisor_fds.len(),
            );
            counts.push(worker_fds.len());
        }
    }

    let baseline = counts[0];
    for (index, count) in counts.iter().enumerate() {
        assert!(
            *count <= baseline + FD_SLACK,
            "worker fd count grew across turns: baseline {baseline}, sample {index} count {count} ({:?})",
            fd_classes(&fd_snapshot(pid))
        );
    }
}

// ---------------------------------------------------------------------------
// Worker fd table across connection churn (the EMFILE class)
// ---------------------------------------------------------------------------

/// Liveness that ignores zombies (an unreaped child keeps its /proc entry).
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

/// Pids whose parent is `ppid`.
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

fn read_exact_timeout(stream: &mut UnixStream, buffer: &mut [u8], deadline: Instant) {
    use std::io::Read as _;
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

/// A raw private-frame probe against a worker's own socket: connect, consume
/// the hello frame, drop. The supervisor's liveness probes and direct
/// clients (`get_direct_worker_transport`) do exactly this shape, and every
/// peer delivery opens one.
fn probe_worker(socket: &Path) {
    let mut stream = UnixStream::connect(socket).expect("connect worker socket");
    stream
        .set_read_timeout(Some(Duration::from_millis(100)))
        .expect("set timeout");
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut prefix = [0u8; 8];
    read_exact_timeout(&mut stream, &mut prefix, deadline);
    let header_len = u32::from_be_bytes(prefix[0..4].try_into().expect("len")) as usize;
    let payload_len = u32::from_be_bytes(prefix[4..8].try_into().expect("len")) as usize;
    let mut header = vec![0u8; header_len];
    read_exact_timeout(&mut stream, &mut header, deadline);
    let mut payload = vec![0u8; payload_len];
    read_exact_timeout(&mut stream, &mut payload, deadline);
    let header: serde_json::Value = serde_json::from_slice(&header).expect("frame header");
    assert_eq!(header["outboundType"], "daemon_hello");
}

/// The persisted worker descriptor's socket path.
fn worker_socket_path(agent_dir: &Path, socket: &Path, worker_id: &str) -> PathBuf {
    let descriptor_dir = pa_daemon::descriptor::descriptor_dir(agent_dir, socket);
    let content = std::fs::read_to_string(descriptor_dir.join(format!("{worker_id}.json")))
        .expect("descriptor file");
    let value: serde_json::Value = serde_json::from_str(&content).expect("descriptor json");
    PathBuf::from(value["socketPath"].as_str().expect("socket path"))
}

/// One live worker keeps serving across open/close client connections: a
/// worker whose fd table grows per connection dies of EMFILE after enough
/// probes, direct clients, and peer deliveries (each agent message opens
/// one). The per-connection event fan-out must die with the connection.
#[test]
fn worker_fd_table_stable_across_client_connection_churn() {
    const PROBES: usize = 15;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let daemon = spawn_daemon(&socket, &agent_dir);
    let supervisor_pid = daemon.child.id();
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        serde_json::json!({ "responses": [ { "text": "churn" } ] }).to_string(),
    )
    .expect("write script");
    client.send_command(
        "c1",
        serde_json::json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
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
    let pid = worker_pid(&agent_dir, &socket, &session_id).expect("worker pid");
    let worker_socket = worker_socket_path(&agent_dir, &socket, &session_id);
    assert!(process_alive(pid), "worker {pid} is alive");

    // Warm-up probes, then the baseline.
    for _ in 0..2 {
        probe_worker(&worker_socket);
    }
    std::thread::sleep(Duration::from_millis(300));
    let baseline = fd_snapshot(pid);
    println!(
        "worker baseline fds {} ({:?})",
        baseline.len(),
        fd_classes(&baseline)
    );

    for _ in 0..PROBES {
        probe_worker(&worker_socket);
        std::thread::sleep(Duration::from_millis(20));
    }
    // Let the worker's read loops observe EOF and the fan-out tasks exit.
    std::thread::sleep(Duration::from_millis(500));
    let final_table = fd_snapshot(pid);
    println!(
        "worker fds after {PROBES} connections: {} ({:?})",
        final_table.len(),
        fd_classes(&final_table)
    );
    assert!(
        final_table.len() <= baseline.len() + 1,
        "worker fd table grew across {PROBES} client connections: baseline {}, final {} ({:?})",
        baseline.len(),
        final_table.len(),
        fd_classes(&final_table)
    );

    // The worker still serves after the churn: a routed command round-trips.
    client.send_command(
        "g1",
        serde_json::json!({ "type": "get_last_assistant_text", "activeSessionId": session_id }),
    );
    let last = client.read_response("g1");
    assert_eq!(last["success"], true, "routed command failed: {last}");

    // And the supervisor held its own baseline through the churn.
    let supervisor_fds = fd_snapshot(supervisor_pid);
    assert!(
        supervisor_fds.len() <= 20,
        "supervisor fd table suspiciously large: {} ({:?})",
        supervisor_fds.len(),
        fd_classes(&supervisor_fds)
    );

    client.send_command(
        "k1",
        serde_json::json!({ "type": "kill", "activeSessionId": session_id }),
    );
    let killed = client.read_response("k1");
    assert_eq!(killed["success"], true, "kill failed: {killed}");
    wait_until(Duration::from_secs(10), || {
        child_pids_of(supervisor_pid)
            .into_iter()
            .filter(|p| process_alive(*p))
            .count()
            == 0
    });
}

// ---------------------------------------------------------------------------
// Restart loop: no orphan workers, stable fds, terminal cleanup
// ---------------------------------------------------------------------------

/// The supervisor's restart loop must not leak worker processes when the
/// create replay keeps failing (a corrupt session store): each failed
/// relaunch kills the worker it spawned, the failure budget is exhausted,
/// the roster drops the session, and no orphan `pa-daemon` process is left
/// holding its socket. This is the "failure 4/5 restart loop" shape from
/// the owner-facing EMFILE report.
#[test]
fn supervisor_restart_loop_leaves_no_orphan_workers() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let daemon = spawn_daemon(&socket, &agent_dir);
    let supervisor_pid = daemon.child.id();
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        serde_json::json!({ "responses": [ { "text": "once" } ] }).to_string(),
    )
    .expect("write script");
    client.send_command(
        "c1",
        serde_json::json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
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
    let session_file = created["data"]["sessionFile"]
        .as_str()
        .expect("session file in create response")
        .to_string();
    let pid = worker_pid(&agent_dir, &socket, &session_id).expect("worker pid");
    assert!(process_alive(pid), "worker {pid} is alive");

    let baseline = fd_snapshot(supervisor_pid);

    // Corrupt the durable session file, then kill the worker: every create
    // replay from here fails (SessionFile::open rejects the file).
    std::fs::write(&session_file, "not valid jsonl\n").expect("corrupt session file");
    let _ = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .expect("send SIGKILL to worker");

    // The restart loop runs to its failure budget and removes the session.
    wait_until(Duration::from_mins(1), || {
        client.send_command("l", serde_json::json!({ "type": "list" }));
        let list = client.read_response("l");
        list["data"]["sessions"]
            .as_array()
            .is_some_and(std::vec::Vec::is_empty)
    });

    // No orphan worker survives the loop: every spawned worker either
    // served or was killed with its failed relaunch.
    std::thread::sleep(Duration::from_millis(500));
    let orphans = child_pids_of(supervisor_pid)
        .into_iter()
        .filter(|p| process_alive(*p))
        .collect::<Vec<_>>();
    assert!(
        orphans.is_empty(),
        "orphan worker processes survived the restart loop: {orphans:?}"
    );

    // The supervisor's own fd table returns to its baseline: each failed
    // relaunch cost one routed connection while it lived, none after.
    std::thread::sleep(Duration::from_millis(500));
    let final_fds = fd_snapshot(supervisor_pid);
    println!(
        "restart loop: supervisor fds baseline {}, final {} ({:?})",
        baseline.len(),
        final_fds.len(),
        fd_classes(&final_fds)
    );
    assert!(
        final_fds.len() <= baseline.len() + 1,
        "supervisor fd table grew across the restart loop: baseline {}, final {}",
        baseline.len(),
        final_fds.len()
    );
}

/// The supervisor config is persisted before bind (the accept contract),
/// so a client that has seen the `daemon_hello` line must find the settled
/// file. The descriptor dir must then hold a valid `supervisor-config`
/// for this supervisor's socket (version 1, this socket path, the resolved
/// default session dir), with no lingering temp file.
#[test]
fn booted_supervisor_persists_its_config() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    let descriptor_dir = pa_daemon::descriptor::descriptor_dir(&agent_dir, &socket);
    let config: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(descriptor_dir.join("supervisor-config"))
            .expect("supervisor config persisted at boot"),
    )
    .expect("supervisor config is valid json");
    assert_eq!(config["version"], 1, "config version: {config}");
    assert_eq!(
        config["socketPath"].as_str(),
        Some(socket.to_string_lossy().to_string().as_str()),
        "config names this supervisor's socket: {config}"
    );
    assert_eq!(
        config["defaultSessionDir"].as_str(),
        Some(
            agent_dir
                .join("sessions")
                .to_string_lossy()
                .to_string()
                .as_str()
        ),
        "config carries the resolved default session dir: {config}"
    );

    // The hello line implies the accept loop already started, so the write
    // must be settled: no temp file may linger beside the config.
    let lingering: Vec<_> = std::fs::read_dir(&descriptor_dir)
        .expect("descriptor dir")
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.starts_with("supervisor-config.tmp"))
        .collect();
    assert!(
        lingering.is_empty(),
        "supervisor config temp files lingered: {lingering:?}"
    );
    client.send_command("l", serde_json::json!({ "type": "list" }));
    assert_eq!(client.read_response("l")["success"], true);
}

/// The fail-before-bind contract of the pre-bind config persist (the
/// reviewer-routed injection): a supervisor whose config write fails
/// never binds its socket - no connect()-success window, no stale socket
/// path. The injection is deterministic: a directory at the
/// `supervisor-config` rename destination breaks the atomic write inside
/// `Supervisor::new`, before `prepare_socket_path` ever runs.
#[test]
fn persist_failure_before_bind_never_exposes_the_socket() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let descriptor_dir = pa_daemon::descriptor::descriptor_dir(&agent_dir, &socket);
    std::fs::create_dir_all(descriptor_dir.join("supervisor-config")).expect("inject");

    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("supervisor")
        .arg("--socket")
        .arg(&socket)
        .arg("--agent-dir")
        .arg(&agent_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn pa-daemon supervisor");
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                assert!(
                    !status.success(),
                    "a pre-bind config persist failure must fail the boot"
                );
                break;
            }
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => panic!("supervisor never exited after the injected persist failure"),
        }
    }
    // The socket was never bound: no path file exists to connect to.
    assert!(
        !socket.exists(),
        "a pre-bind persist failure must never expose the socket path"
    );
}
