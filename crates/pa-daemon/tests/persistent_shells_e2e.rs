//! Persistent `bash()` shells across the daemon: a shell started with
//! `bash(..., persistent=True)` survives the daemon's shutdown (it is neither
//! journaled for the orphan reaper nor killed by the kernel's exit hook), shows
//! on the INACTIVE session's saved-catalog row, is re-attached by the kernel of
//! the reopened session, and keeps running after the session's delete, its
//! record still assigned to the deleted session. The machine-wide
//! `list_persistent_shells` lists every shell with its assignment, and
//! `kill_persistent_shell` ends an orphan. The live-kernel test skips (with a
//! note) without a kernel install.
#![cfg(target_os = "linux")]
// Narrowing casts sit at OS boundaries (pid) where the kernel bounds the values.
#![allow(clippy::cast_possible_wrap, clippy::cast_possible_truncation)]
// Style gate only, not correctness: the live test is one long scenario.
#![allow(clippy::too_many_lines)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use nix::sys::signal::{killpg, Signal};
use nix::unistd::Pid;
use serde_json::{json, Value};

fn kernel_python() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("PA_E2E_KERNEL_PYTHON") {
        return Some(PathBuf::from(explicit));
    }
    let candidate = PathBuf::from(std::env::var("HOME").unwrap_or_default())
        .join(".prime/agent/kernel-venv/bin/python");
    if candidate.exists() {
        return Some(candidate);
    }
    eprintln!(
        "kernel python {} not found; skipping live persistent-shell e2e",
        candidate.display()
    );
    None
}

struct Daemon {
    child: Child,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Persistent shells outlive their session: never leak one.
struct GroupGuard(i32);

impl Drop for GroupGuard {
    fn drop(&mut self) {
        let _ = killpg(Pid::from_raw(self.0), Signal::SIGKILL);
    }
}

/// Whether any non-zombie process is in group `pgid` (an unreaped zombie still
/// answers `kill(-pgid, 0)`).
fn group_alive(pgid: i32) -> bool {
    std::fs::read_dir("/proc")
        .expect("read /proc")
        .flatten()
        .filter_map(|entry| std::fs::read_to_string(entry.path().join("stat")).ok())
        .any(|stat| {
            let fields: Vec<&str> = stat[stat.rfind(')').map_or(0, |at| at + 2)..]
                .split(' ')
                .collect();
            fields.first() != Some(&"Z") && fields.get(2) == Some(&pgid.to_string().as_str())
        })
}

// The returned Daemon's Drop kills and reaps the child.
#[allow(clippy::zombie_processes)]
fn spawn_supervisor(socket: &Path, agent_dir: &Path, kernel_python: Option<&Path>) -> Daemon {
    std::fs::create_dir_all(agent_dir).expect("agent dir");
    let mut command = Command::new(env!("CARGO_BIN_EXE_pa-daemon"));
    command
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .env("PRIME_AGENT_CODING_AGENT_DIR", agent_dir)
        .env_remove("RLM_SESSION_DIR")
        .env_remove("RLM_HARNESS_STATE_DIR")
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(python) = kernel_python {
        command.env("PRIME_AGENT_KERNEL_PYTHON", python);
    }
    let child = command.spawn().expect("spawn pa-daemon supervisor");
    let deadline = Instant::now() + Duration::from_secs(15);
    while UnixStream::connect(socket).is_err() {
        assert!(Instant::now() < deadline, "supervisor socket never came up");
        std::thread::sleep(Duration::from_millis(20));
    }
    Daemon { child }
}

struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Client {
    fn connect(socket: &Path) -> Self {
        let stream = UnixStream::connect(socket).expect("connect supervisor");
        let writer = stream.try_clone().expect("clone socket");
        stream
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer,
        };
        let _hello = client.read_line();
        client
    }

    fn request(&mut self, id: &str, command: &Value) -> Value {
        let mut line = json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        })
        .to_string();
        line.push('\n');
        self.writer.write_all(line.as_bytes()).expect("send");
        let deadline = Instant::now() + Duration::from_mins(4);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let reply = self.read_line();
            if reply.get("id").and_then(Value::as_str) == Some(id)
                && reply.get("type").and_then(Value::as_str) == Some("response")
            {
                assert_eq!(reply["success"], true, "{id} failed: {reply}");
                return reply;
            }
        }
    }

    fn read_line(&mut self) -> Value {
        let mut line = String::new();
        loop {
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => line.clear(),
                Ok(_) => return serde_json::from_str(line.trim()).expect("parse line"),
                Err(_) => {}
            }
        }
    }
}

fn saved_row(client: &mut Client, id: &str, sessions_dir: &Path, session_id: &str) -> Value {
    let listed = client.request(
        id,
        &json!({ "type": "list_saved_sessions", "cwd": "/",
                 "sessionDir": sessions_dir.to_string_lossy() }),
    );
    listed["data"]["sessions"]
        .as_array()
        .expect("sessions")
        .iter()
        .find(|row| row["id"] == session_id)
        .cloned()
        .expect("the session has a catalog row")
}

#[test]
fn persistent_python_unit_regressions() {
    let Some(python) = kernel_python() else {
        assert!(
            std::env::var_os("CI").is_none(),
            "CI must bootstrap the kernel interpreter before persistent-shell tests"
        );
        return;
    };
    let runtime = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../prime-agent-runtime");
    let output = Command::new(python)
        .current_dir(&runtime)
        .env("PYTHONPATH", runtime.join("src"))
        .args(["-m", "unittest", "test.test_bash.PersistentBashTest"])
        .output()
        .expect("run persistent-shell Python regressions");
    assert!(
        output.status.success(),
        "persistent-shell Python regressions failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn saved_row_lists_its_live_shells_and_the_machine_wide_list_every_shell() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    let session_id = "11111111-2222-3333-4444-555555555555";
    std::fs::write(
        sessions_dir.join(format!("{session_id}.jsonl")),
        format!(
            "{}\n",
            json!({ "type": "session", "version": 3, "id": session_id,
                    "timestamp": "2026-01-01T00:00:00.000Z", "cwd": "/tmp" })
        ),
    )
    .expect("write session");
    let mut sleeper = Command::new("sleep")
        .arg("60")
        .process_group(0)
        .spawn()
        .expect("spawn sleeper");
    let _guard = GroupGuard(sleeper.id() as i32);
    let mut gone = Command::new("true").spawn().expect("spawn true");
    gone.wait().expect("reap true");
    let sleeper_start_id = pa_daemon::lease::get_process_start_id(sleeper.id()).expect("start id");
    let home = agent_dir.join("persistent-shells");
    std::fs::create_dir_all(&home).expect("persistent-shell home");
    for (id, pid, start_id, session) in [
        ("a", sleeper.id(), sleeper_start_id.as_str(), session_id),
        ("b", gone.id(), "proc:0", session_id),
        (
            "c",
            sleeper.id(),
            sleeper_start_id.as_str(),
            "another-session",
        ),
    ] {
        let id = id.repeat(32);
        std::fs::write(
            home.join(format!("{id}.json")),
            json!({ "id": id, "pid": pid, "startId": start_id, "command": "sleep 60",
                    "startedAt": "2026-01-01T00:00:00+00:00", "sessionId": session })
            .to_string(),
        )
        .expect("write record");
    }

    let socket = dir.path().join("supervisor.sock");
    let _daemon = spawn_supervisor(&socket, &agent_dir, None);
    let mut client = Client::connect(&socket);
    let row = saved_row(&mut client, "l1", &sessions_dir, session_id);

    assert_eq!(
        row["persistentShells"],
        json!([{ "id": "a".repeat(32), "command": "sleep 60", "pid": sleeper.id(),
                 "startedAt": "2026-01-01T00:00:00+00:00", "status": "running",
                 "persistent": true }])
    );
    let listed = client.request("s1", &json!({ "type": "list_persistent_shells" }));
    let mut shells: Vec<String> = listed["data"]["activities"]
        .as_array()
        .expect("activities")
        .iter()
        .map(|row| format!("{} {} {}", row["id"], row["status"], row["sessionId"]))
        .collect();
    shells.sort();
    assert_eq!(
        shells,
        [
            format!("\"{}\" \"running\" \"{session_id}\"", "a".repeat(32)),
            format!("\"{}\" \"finished\" \"{session_id}\"", "b".repeat(32)),
            format!("\"{}\" \"running\" \"another-session\"", "c".repeat(32)),
        ],
        "the machine-wide list holds every shell with its assignment"
    );
    sleeper.kill().expect("kill sleeper");
    sleeper.wait().expect("reap sleeper");
}

#[test]
fn persistent_shell_survives_daemon_shutdown_is_reattached_and_outlives_session_delete() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = dir.path().join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    let receipt = dir.path().join("pid.txt");
    let script = write_faux_script(
        &dir.path().join("faux.json"),
        &format!(
            "h = bash('echo hi; sleep 600', persistent=True)\nopen({:?}, 'w').write(str(h.pid))\n",
            receipt.to_string_lossy()
        ),
    );

    let baseline = kernel_pids();
    let socket = dir.path().join("supervisor.sock");
    let mut daemon = spawn_supervisor(&socket, &agent_dir, Some(&kernel_python));
    let mut client = Client::connect(&socket);
    let created = client.request(
        "c1",
        &json!({ "type": "create", "config": {
            "cwd": dir.path().to_string_lossy(),
            "sessionDir": sessions_dir.to_string_lossy(),
            "script": script.to_string_lossy(),
        } }),
    );
    let session_id = created["data"]["sessionId"]
        .as_str()
        .expect("session id")
        .to_string();
    client.request(
        "p1",
        &json!({ "type": "prompt", "activeSessionId": session_id, "message": "start it" }),
    );
    client.request(
        "i1",
        &json!({ "type": "wait_for_idle", "activeSessionId": session_id }),
    );
    let pid: i32 = std::fs::read_to_string(&receipt)
        .expect("the cell wrote the shell pid")
        .parse()
        .expect("pid");
    let _guard = GroupGuard(pid);

    // Daemon stop: the workers dispose their kernels (exit hook + orphan reaper).
    client.request("sd", &json!({ "type": "shutdown" }));
    let deadline = Instant::now() + Duration::from_secs(90);
    while daemon.child.try_wait().expect("poll supervisor").is_none() {
        assert!(Instant::now() < deadline, "the supervisor never exited");
        std::thread::sleep(Duration::from_millis(100));
    }
    let deadline = Instant::now() + Duration::from_secs(90);
    while kernel_pids().iter().any(|pid| !baseline.contains(pid)) {
        assert!(
            Instant::now() < deadline,
            "the session kernel outlived shutdown"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(
        group_alive(pid),
        "the persistent shell died with the daemon"
    );

    // A fresh daemon lists the inactive session's shell.
    let socket = dir.path().join("supervisor-2.sock");
    let _daemon = spawn_supervisor(&socket, &agent_dir, Some(&kernel_python));
    let mut client = Client::connect(&socket);
    let row = saved_row(&mut client, "l1", &sessions_dir, &session_id);
    assert_eq!(row["persistentShells"][0]["pid"], pid);

    // Reopening the session boots a new kernel, which re-attaches the shell.
    let reattached = dir.path().join("reattached.json");
    let script = write_faux_script(
        &dir.path().join("faux-reopen.json"),
        &format!(
            "import json\nfrom rlm import persistent_shells\njson.dump([[h.pid, h.running, h.output()] for h in persistent_shells()], open({:?}, 'w'))\n",
            reattached.to_string_lossy()
        ),
    );
    let session_file = sessions_dir.join(format!("{session_id}.jsonl"));
    let reopened = client.request(
        "c2",
        &json!({ "type": "create", "sessionPath": session_file.to_string_lossy(), "config": {
            "cwd": dir.path().to_string_lossy(),
            "sessionDir": sessions_dir.to_string_lossy(),
            "script": script.to_string_lossy(),
        } }),
    );
    let active_id = reopened["data"]["activeSessionId"]
        .as_str()
        .or_else(|| reopened["data"]["id"].as_str())
        .expect("active session id")
        .to_string();
    client.request(
        "p2",
        &json!({ "type": "prompt", "activeSessionId": active_id, "message": "find it" }),
    );
    client.request(
        "i2",
        &json!({ "type": "wait_for_idle", "activeSessionId": active_id }),
    );
    let handles: Value = serde_json::from_str(
        &std::fs::read_to_string(&reattached).expect("the reopened kernel wrote its handles"),
    )
    .expect("parse handles");
    assert_eq!(handles, json!([[pid, true, "hi\n"]]));

    // Close the session, then delete it: the shell runs on as an orphan.
    client.request(
        "k1",
        &json!({ "type": "kill", "activeSessionId": active_id }),
    );
    client.request(
        "d1",
        &json!({ "type": "delete_saved_session", "sessionPath": session_file.to_string_lossy() }),
    );
    assert!(!session_file.exists());
    assert!(
        group_alive(pid),
        "the session delete killed its persistent shell"
    );
    let records: Vec<Value> = std::fs::read_dir(agent_dir.join("persistent-shells"))
        .expect("persistent-shell home")
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .map(|entry| {
            serde_json::from_slice(&std::fs::read(entry.path()).expect("read record"))
                .expect("parse record")
        })
        .collect();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["pid"], pid);
    assert_eq!(records[0]["sessionId"], session_id.as_str());

    // The machine-wide list still names the deleted session; its kill ends the orphan.
    let listed = client.request("s1", &json!({ "type": "list_persistent_shells" }));
    let shell = &listed["data"]["activities"][0];
    assert_eq!(
        (&shell["pid"], &shell["sessionId"], &shell["status"]),
        (&json!(pid), &json!(session_id), &json!("running"))
    );
    client.request(
        "x1",
        &json!({ "type": "kill_persistent_shell", "shellId": shell["id"] }),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while group_alive(pid) {
        assert!(
            Instant::now() < deadline,
            "the kill left the orphan's group alive"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    let listed = client.request("s2", &json!({ "type": "list_persistent_shells" }));
    assert_eq!(
        listed["data"]["activities"][0]["status"], "finished",
        "the killed orphan stays listed as finished"
    );
}

fn write_faux_script(path: &Path, cell: &str) -> PathBuf {
    std::fs::write(
        path,
        json!({ "engine": "faux", "responses": [
            { "content": [{ "type": "toolCall", "name": "python_repl",
                            "arguments": { "code": cell } }] },
            { "text": "done" },
        ] })
        .to_string(),
    )
    .expect("write faux script");
    path.to_path_buf()
}

/// Every live `python -m rlm.repl` kernel pid on the box.
fn kernel_pids() -> Vec<u32> {
    std::fs::read_dir("/proc")
        .expect("read /proc")
        .flatten()
        .filter_map(|entry| {
            let pid = entry.file_name().to_string_lossy().parse::<u32>().ok()?;
            let cmdline = std::fs::read_to_string(entry.path().join("cmdline")).ok()?;
            let args: Vec<&str> = cmdline.split('\0').collect();
            args.windows(2)
                .any(|window| window == ["-m", "rlm.repl"])
                .then_some(pid)
        })
        .collect()
}
