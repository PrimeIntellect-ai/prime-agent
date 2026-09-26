//! Per-worker stderr capture e2e against the real supervisor and worker
//! binaries: a worker's stderr lands in its per-worker log under the
//! daemon's logs dir, a worker that never comes up reports the captured
//! stderr tail in the create failure, and the spawn-time prune bounds the
//! retained logs. The never-ready case is driven by a `TMPDIR` pointing
//! at a plain file: the worker resolves its socket dir under `TMPDIR` and
//! dies at the socket-path preparation with the failure on its
//! (captured) stderr, so the supervisor's probe budget runs out against a
//! dead worker — no test-only fault hook, just the real bind path
//! failing.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

struct Daemon {
    child: Child,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct DaemonBuilder {
    command: Command,
}

impl DaemonBuilder {
    fn new(socket: &Path, agent_dir: &Path) -> Self {
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
        DaemonBuilder { command }
    }

    fn env(mut self, key: &str, value: impl AsRef<std::ffi::OsStr>) -> Self {
        self.command.env(key, value);
        self
    }

    // The timeout panic path cannot wait on the child; the test process
    // exits immediately afterwards, reaping it.
    #[allow(clippy::zombie_processes)]
    fn spawn(mut self, socket: &Path) -> Daemon {
        let child = self.command.spawn().expect("spawn pa-daemon supervisor");
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if socket.exists() {
                return Daemon { child };
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("supervisor socket never appeared");
    }
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
        let deadline = Instant::now() + Duration::from_secs(20);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => {}
                Ok(_) => {
                    return serde_json::from_str(line.trim()).expect("parse response line");
                }
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
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(|v| v.as_str()) == Some(id) {
                return line;
            }
        }
    }
}

/// The active session id a create response answered (the summary's `id`,
/// the same id that names the worker's stderr log).
fn create_session(client: &mut Client, request_id: &str, config: &Value) -> String {
    client.send_command(request_id, json!({ "type": "create", "config": config }));
    let created = client.read_response(request_id);
    assert_eq!(created["success"], true, "create failed: {created}");
    created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id in create response")
        .to_string()
}

fn write_script(dir: &Path, responses: &[&str]) -> PathBuf {
    let script_path = dir.join("engine-script.json");
    let scripted: Vec<Value> = responses
        .iter()
        .map(|text| json!({ "text": text }))
        .collect();
    std::fs::write(&script_path, json!({ "responses": scripted }).to_string())
        .expect("write script");
    script_path
}

/// The worker stderr logs currently in the daemon's logs dir.
fn worker_stderr_logs(agent_dir: &Path) -> Vec<String> {
    std::fs::read_dir(agent_dir.join("logs"))
        .expect("logs dir exists")
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.starts_with("worker-") && name.ends_with(".stderr.log"))
        .collect()
}

#[test]
fn worker_stderr_lands_in_the_per_worker_log_and_prunes_retention() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(agent_dir.join("logs")).expect("logs dir");
    // Retention pressure: more leftover logs than the daemon keeps, each
    // older than anything this run writes (backdated mtimes, the
    // session-archive test convention).
    for index in 0..70 {
        let path = agent_dir
            .join("logs")
            .join(format!("worker-old{index:03}.stderr.log"));
        std::fs::write(&path, "leftover from an earlier daemon run\n").expect("leftover log");
        let mtime = filetime::FileTime::from_unix_time(index as i64, 0);
        filetime::set_file_mtime(&path, mtime).expect("set mtime");
    }
    // PA_DAEMON_DEBUG makes the real worker narrate its boot on stderr
    // (accepted connection, auth ok): the capture's observable content.
    let _daemon = DaemonBuilder::new(&socket, &agent_dir)
        .env("PA_DAEMON_DEBUG", "1")
        .spawn(&socket);

    let script_path = write_script(dir.path(), &["first scripted"]);
    let create_config = json!({
        "cwd": dir.path().to_string_lossy(),
        "sessionDir": agent_dir.join("sessions").to_string_lossy(),
        "script": script_path.to_string_lossy(),
    });
    let mut client = Client::connect(&socket);
    let session_id = create_session(&mut client, "c1", &create_config);

    let log_path = agent_dir
        .join("logs")
        .join(format!("worker-{session_id}.stderr.log"));
    let contents =
        std::fs::read_to_string(&log_path).expect("worker stderr log for the created session");
    assert!(
        contents.contains("auth ok"),
        "the worker's stderr output is in its per-worker log: {contents}"
    );

    // The spawn-time prune kept the newest logs only: this run's log plus
    // the newest leftovers up to the retention cap, the oldest deleted.
    let remaining = worker_stderr_logs(&agent_dir);
    assert!(remaining.len() <= 64, "retention is bounded: {remaining:?}");
    assert!(remaining.contains(&format!("worker-{session_id}.stderr.log")));
    assert!(
        remaining.iter().any(|name| name.starts_with("worker-old")),
        "the retention cap keeps room for the fresh log without wiping recent history"
    );
    assert!(
        !remaining.contains(&"worker-old000.stderr.log".to_string()),
        "the oldest leftover was pruned: {remaining:?}"
    );
}

#[test]
fn never_ready_worker_failure_carries_the_captured_stderr_tail() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    // The worker resolves its socket dir under TMPDIR: pointing TMPDIR
    // at a plain file makes the socket dir un-creatable (ENOTDIR, even
    // for root), so the real worker dies at its socket-path preparation
    // with the failure on stderr — the exact silent death the capture
    // exists for. The supervisor's own endpoints are explicit paths, so
    // it boots untouched.
    let tmpdir_file = dir.path().join("not-a-directory");
    std::fs::write(&tmpdir_file, "the worker's socket dir would live here\n")
        .expect("write tmpdir file");

    // The supervisor reads this override at launch time
    // (`WORKER_CONNECT_TIMEOUT_ENV`, crate-private): a short probe budget
    // turns the dead worker into the not-ready failure in seconds instead
    // of the default launch window.
    let _daemon = DaemonBuilder::new(&socket, &agent_dir)
        .env("PA_DAEMON_WORKER_CONNECT_TIMEOUT_MS", "2000")
        .env("TMPDIR", &tmpdir_file)
        .spawn(&socket);

    let script_path = write_script(dir.path(), &["never reached"]);
    let create_config = json!({
        "cwd": dir.path().to_string_lossy(),
        "sessionDir": agent_dir.join("sessions").to_string_lossy(),
        "script": script_path.to_string_lossy(),
    });
    let mut client = Client::connect(&socket);
    client.send_command("c1", json!({ "type": "create", "config": create_config }));
    let failed = client.read_response("c1");
    assert_eq!(failed["success"], false, "create must fail: {failed}");
    let message = failed["error"].as_str().expect("error message");
    assert!(
        message.starts_with("session worker "),
        "names the worker first: {message}"
    );
    assert!(
        message.contains("did not come up in time"),
        "the not-ready headline: {message}"
    );
    assert!(
        message.contains("session worker stderr ("),
        "carries the captured stderr tail block: {message}"
    );
    assert!(
        message.contains("Error:"),
        "the tail holds the worker's dying stderr: {message}"
    );

    // The same evidence stays on disk in the per-worker log.
    let logs = worker_stderr_logs(&agent_dir);
    assert_eq!(logs.len(), 1, "one launch, one captured log: {logs:?}");
    let contents = std::fs::read_to_string(agent_dir.join("logs").join(&logs[0]))
        .expect("read worker stderr log");
    assert!(
        contents.contains("Error:"),
        "the worker's stderr landed in the file: {contents}"
    );
    assert!(
        message.contains(&logs[0]),
        "the tail names the log it read: {message}"
    );
}
