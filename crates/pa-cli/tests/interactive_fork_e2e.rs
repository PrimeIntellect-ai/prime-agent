//! End-to-end verifier for the interactive `--fork` launch (the audit's S4
//! stub): the fork copies its source into a fresh session file client-side,
//! the daemon opens the copy — never the source — through the create
//! `sessionPath`, and the TUI renders the copied transcript and takes new
//! turns on the fork. The real supervisor, the re-executed test binary as
//! the interactive client (the same `main_with_runtime` entry point the
//! shipped binary calls), and the scripted engine seam drive the full
//! path; the source is hosted by a live worker for the whole run, proving
//! a session the daemon already owns forks fine (TS parity: no
//! daemon-active guard on the fork arm).
#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use nix::fcntl::{fcntl, FcntlArg::F_SETFL, OFlag};
use nix::pty::{openpty, Winsize};
use serde_json::{json, Value};

use pa_types::daemon::DaemonCommand;

/// The parent hands the child its launch through this env var; unset, the
/// test passes trivially (a plain `cargo test` runs only the parent).
const CHILD_ENV: &str = "PA_INTERACTIVE_FORK_CHILD";

/// The interactive client half: the same entry point the shipped binary
/// calls, over the pty the parent opened — the real fork startup
/// (`--fork` resolution, the client-side copy, the daemon create, the TUI).
/// The exit code lands in the outcome file for the parent to assert.
#[test]
fn interactive_fork_child_mode() {
    let Ok(config) = std::env::var(CHILD_ENV) else {
        return;
    };
    let config: Value = serde_json::from_str(&config).expect("child config");
    std::env::set_current_dir(config["cwd"].as_str().expect("cwd")).expect("child cwd");
    let args = vec![
        "--fork".to_string(),
        config["selector"].as_str().expect("selector").to_string(),
        "--daemon-socket".to_string(),
        config["socket"].as_str().expect("socket").to_string(),
    ];
    let code = pa_cli::main_with_runtime(args, &pa_cli::PrintRuntime);
    std::fs::write(
        config["outcome"].as_str().expect("outcome path"),
        code.to_string(),
    )
    .expect("write the launch outcome");
}

struct Supervisor {
    child: Child,
    socket: PathBuf,
}

/// Stop the supervisor by protocol and reap every worker it spawned, so a
/// failing test leaks nothing. Drop runs even on panic.
impl Drop for Supervisor {
    fn drop(&mut self) {
        let supervisor_pid = graceful_shutdown(&self.socket);
        let worker_pids = supervisor_pid.map(child_pids_of).unwrap_or_default();
        let _ = self.child.kill();
        let _ = self.child.wait();
        for pid in worker_pids {
            kill_worker(&pid);
        }
        let _ = std::fs::remove_file(&self.socket);
    }
}

/// Pids whose parent is `ppid` (the supervisor's live worker children).
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
        // `comm` can contain spaces and parens, so parse after the last ')'.
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

/// Liveness that ignores zombies: an unreaped child keeps its `/proc`
/// entry, so path existence alone would call an exited process alive.
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

/// Send the daemon protocol shutdown and return the supervisor pid it
/// names, so the caller can reap the detached workers it spawned.
fn graceful_shutdown(socket: &Path) -> Option<u32> {
    let Ok(stream) = std::os::unix::net::UnixStream::connect(socket) else {
        return None;
    };
    let Ok(write_half) = stream.try_clone() else {
        return None;
    };
    let mut reader = BufReader::new(stream);
    let mut writer = write_half;
    let mut hello = String::new();
    if reader.read_line(&mut hello).is_err() {
        return None;
    }
    let Ok(hello) = serde_json::from_str::<Value>(hello.trim()) else {
        return None;
    };
    let supervisor_pid = hello["supervisorPid"].as_u64()? as u32;
    let shutdown = json!({
        "type": "command",
        "id": "fork-e2e-shutdown",
        "protocol": { "name": "prime-agent.daemon", "version": 7 },
        "command": { "type": "shutdown" },
    });
    let mut line = serde_json::to_string(&shutdown).expect("serialize shutdown");
    line.push('\n');
    let _ = writer.write_all(line.as_bytes());
    let _ = writer.flush();
    let deadline = Instant::now() + Duration::from_secs(10);
    while process_alive(supervisor_pid) {
        if Instant::now() > deadline {
            return Some(supervisor_pid);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    None
}

#[allow(clippy::zombie_processes)]
fn spawn_supervisor(socket: &Path, agent_dir: &Path, session_dir: &Path) -> Supervisor {
    let mut command = Command::new(env!("CARGO_BIN_EXE_prime-agent"));
    command
        .args(["--mode", "daemon", "--daemon-socket"])
        .arg(socket)
        .env("PRIME_AGENT_CODING_AGENT_DIR", agent_dir)
        .env("PRIME_AGENT_SESSION_DIR", session_dir)
        .env("PI_OFFLINE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for var in [
        pa_daemon::worker::WORKER_ROLE_ENV,
        pa_daemon::worker::WORKER_TOKEN_ENV,
        pa_daemon::worker::WORKER_ACTIVE_SESSION_ID_ENV,
        pa_daemon::worker::WORKER_RECOVERY_JOURNAL_ENV,
        pa_daemon::worker::WORKER_SUPERVISOR_SOCKET_ENV,
        pa_daemon::worker::WORKER_SOCKET_ENV,
        pa_daemon::worker::WORKER_INSTANCE_ID_ENV,
        pa_daemon::worker::WORKER_SCRIPT_ENV,
        pa_daemon::lease::SESSION_LEASE_OWNER_ID_ENV,
    ] {
        command.env_remove(var);
    }
    // The supervisor-lost exit window (a short one for the teardown) and
    // the worker connect budget (the gate boxes are slower than a laptop).
    command.env(
        pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
        "15000",
    );
    command.env("PA_DAEMON_WORKER_CONNECT_TIMEOUT_MS", "90000");
    let child = command.spawn().expect("spawn prime-agent --mode daemon");
    let deadline = Instant::now() + Duration::from_secs(15);
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

/// Open the source session as a live daemon worker (a create with
/// `sessionPath` over the socket), so the fork runs against a session the
/// daemon already hosts. Returns the worker's active session id.
async fn make_session_active(socket: &Path, session_path: &Path, cwd: &Path) -> String {
    let (client, _events) = pa_tui::daemon_client::DaemonClient::connect(socket)
        .await
        .expect("connect daemon");
    let data = client
        .request_ok(DaemonCommand::Create {
            id: None,
            session_path: Some(session_path.to_string_lossy().to_string()),
            continue_recent: None,
            no_session: None,
            name: None,
            config: Some(json!({
                "cwd": cwd.display().to_string(),
                "sessionDir": session_path.parent().expect("sessions dir").display().to_string(),
            })),
            telemetry_disabled: None,
            runtime_metadata: None,
            lifecycle: None,
            env: None,
            launch_env: None,
            rest: Default::default(),
        })
        .await
        .expect("open the source session");
    client.close();
    data.get("activeSessionId")
        .or_else(|| data.get("id"))
        .and_then(Value::as_str)
        .expect("session id")
        .to_string()
}

/// The live daemon roster rows: `sessionFile` (canonical) and
/// `activeSessionId` per hosted session.
async fn daemon_roster(socket: &Path) -> Vec<(PathBuf, String)> {
    let (client, _events) = pa_tui::daemon_client::DaemonClient::connect(socket)
        .await
        .expect("connect daemon");
    let list = client
        .request_ok(DaemonCommand::List {
            id: None,
            all: None,
            cwd: None,
            session_dir: None,
            include_client_owned: None,
            rest: Default::default(),
        })
        .await
        .expect("list sessions");
    client.close();
    list.get("sessions")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let file = row.get("sessionFile")?.as_str()?;
                    let id = row
                        .get("activeSessionId")
                        .or_else(|| row.get("id"))
                        .and_then(Value::as_str)?;
                    Some((PathBuf::from(file), id.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn read_entries(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .expect("read session file")
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()
        .expect("valid session entries")
}

fn session_files(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .expect("read sessions dir")
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .collect()
}

/// Non-blocking reader over the pty master, collecting the raw byte stream
/// the child writes (the login-panel harness's reader).
struct PtyReader {
    file: std::fs::File,
    output: Vec<u8>,
}

impl PtyReader {
    fn new(master: OwnedFd) -> PtyReader {
        let fd = master.as_raw_fd();
        fcntl(fd, F_SETFL(OFlag::O_NONBLOCK)).expect("pty master non-blocking");
        PtyReader {
            file: master.into(),
            output: Vec::new(),
        }
    }

    fn write(&mut self, payload: &[u8]) {
        self.file.write_all(payload).expect("write to the pty");
    }

    /// Drain the master until the needle appears in the collected stream,
    /// bounded by the harness deadline.
    fn wait_for(&mut self, needle: &str, what: &str) {
        let deadline = Instant::now() + Duration::from_secs(45);
        loop {
            if find_subsequence(&self.output, needle.as_bytes()).is_some() {
                return;
            }
            let mut buffer = [0u8; 8192];
            match self.file.read(&mut buffer) {
                Ok(0) | Err(_) => {}
                Ok(n) => self.output.extend_from_slice(&buffer[..n]),
            }
            if Instant::now() > deadline {
                let text = String::from_utf8_lossy(&self.output);
                panic!(
                    "timeout waiting for {what} (needle {needle:?}); pty tail:\n{}",
                    &text[text.len().saturating_sub(4000)..]
                );
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// The interactive `--fork` launch, end to end: the client copies a live
/// hosted session into a fresh file, the daemon opens the fork, the TUI
/// renders the copied transcript and takes a new turn on it, and the
/// source stays hosted with its bytes untouched.
#[tokio::test]
async fn interactive_fork_launch_copies_and_the_daemon_opens_the_fork() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    let cwd = dir.path().join("project");
    std::fs::create_dir_all(&session_dir).expect("sessions dir");
    std::fs::create_dir_all(&cwd).expect("project dir");
    let socket = dir.path().join("daemon.sock");
    let supervisor = spawn_supervisor(&socket, &agent_dir, &session_dir);

    // The source session: a real print-mode run of the real binary (the
    // same isolated-home contract the print runtime e2e uses). The print
    // runtime reads the script env as the script JSON itself.
    let seeded = Command::new(env!("CARGO_BIN_EXE_prime-agent"))
        .args(["-p", "seedphrase4fork tell me"])
        .current_dir(&cwd)
        .env("PRIME_AGENT_CODING_AGENT_DIR", &agent_dir)
        .env("PRIME_AGENT_SESSION_DIR", &session_dir)
        .env("PI_OFFLINE", "1")
        .env(
            "PRIME_AGENT_FAUX_SCRIPT",
            json!({ "responses": ["seedonlyanswer"] }).to_string(),
        )
        .env_remove("RLM_DEPTH")
        .output()
        .expect("seed run");
    assert!(
        seeded.status.success(),
        "the seed run failed: {}",
        String::from_utf8_lossy(&seeded.stderr)
    );
    let files = session_files(&session_dir);
    assert_eq!(files.len(), 1, "one source session file");
    let source = files.into_iter().next().expect("the source file");
    let source_entries = read_entries(&source);
    let source_id = source_entries[0]["id"].as_str().expect("id").to_string();

    // Host the source on a live worker: the fork must work on a session
    // the daemon already owns (the copy never touches the hosted file).
    let active_source = make_session_active(&socket, &source, &cwd).await;
    assert_eq!(active_source, source_id);
    let source_before = std::fs::read(&source).expect("read source");

    // The interactive launch child: the same entry point the binary calls,
    // on a pty, forking the hosted source by its id. The interactive seam
    // reads PRIME_AGENT_FAUX_SCRIPT as a script FILE path (it rides the
    // create config to the daemon worker).
    let fork_script = dir.path().join("script-fork.json");
    std::fs::write(
        &fork_script,
        json!({ "responses": ["forkfollowanswer"] }).to_string(),
    )
    .expect("write fork script");
    let outcome = dir.path().join("outcome");
    let pty = openpty(
        Some(&Winsize {
            ws_row: 24,
            ws_col: 100,
            ws_xpixel: 0,
            ws_ypixel: 0,
        }),
        None,
    )
    .expect("open pty");
    let slave = pty.slave;
    let mut child = Command::new(std::env::current_exe().expect("test binary"))
        .arg("--exact")
        .arg("interactive_fork_child_mode")
        .env(
            CHILD_ENV,
            json!({
                "socket": socket.display().to_string(),
                "cwd": cwd.display().to_string(),
                "selector": source_id,
                "outcome": outcome.display().to_string(),
            })
            .to_string(),
        )
        .env("PRIME_AGENT_CODING_AGENT_DIR", &agent_dir)
        .env("PRIME_AGENT_SESSION_DIR", &session_dir)
        .env("PI_OFFLINE", "1")
        .env("PRIME_AGENT_FAUX_SCRIPT", fork_script.display().to_string())
        .env_remove("TMUX")
        .env_remove("RLM_DEPTH")
        .stdin(slave.try_clone().expect("clone pty slave"))
        .stdout(slave.try_clone().expect("clone pty slave"))
        .stderr(slave)
        .spawn()
        .expect("spawn the interactive client child");
    let mut pty_reader = PtyReader::new(pty.master);

    // The TUI renders the forked transcript: the source's exchange.
    pty_reader.wait_for("seedphrase4fork", "the copied transcript");

    // The daemon hosts the fork: a roster row naming a new session file —
    // never the source — under its own id.
    let source_canonical = pa_daemon::lease::canonical_session_path(&source);
    let deadline = Instant::now() + Duration::from_secs(45);
    let (fork_file, fork_id) = 'hosted: {
        loop {
            for (file, id) in daemon_roster(&socket).await {
                if pa_daemon::lease::canonical_session_path(&file) != source_canonical {
                    break 'hosted (file, id);
                }
            }
            assert!(
                Instant::now() < deadline,
                "the daemon never hosted the fork"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    };

    let fork_entries = read_entries(&fork_file);
    // Fresh header: new id, the source as parentSession, the target cwd.
    assert_ne!(fork_id, source_id, "the fork has its own session id");
    assert_eq!(
        fork_entries[0]["id"].as_str(),
        Some(fork_id.as_str()),
        "the roster row hosts the fork file's own header id"
    );
    assert_ne!(
        fork_entries[0]["id"].as_str(),
        Some(source_id.as_str()),
        "the fork header carries the new id"
    );
    assert_eq!(
        fork_entries[0]["parentSession"].as_str(),
        Some(source.display().to_string().as_str()),
        "the fork header parents at the source"
    );
    assert_eq!(
        fork_entries[0]["cwd"].as_str(),
        Some(cwd.display().to_string().as_str()),
        "the fork adopts the launch cwd"
    );
    // The branch copied the source's exchange.
    let texts: Vec<&str> = fork_entries
        .iter()
        .filter(|entry| entry["type"] == "message")
        .filter_map(|entry| entry["message"]["content"][0]["text"].as_str())
        .collect();
    assert!(
        texts.contains(&"seedphrase4fork tell me"),
        "the copied user row rides the fork: {texts:?}"
    );
    assert!(
        texts.contains(&"seedonlyanswer"),
        "the copied assistant row rides the fork: {texts:?}"
    );

    // The fork is live: a new turn on it answers through the scripted
    // engine.
    pty_reader.write(b"forked turn\r");
    pty_reader.wait_for("forkfollowanswer", "the new turn on the fork");

    // Exit cleanly (ctrl+d), and the launch reports success.
    pty_reader.write(b"\x04");
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(status) = child.try_wait().expect("child status") {
            assert!(status.success(), "the interactive child failed: {status}");
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the interactive child never exited"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let outcome = std::fs::read_to_string(&outcome).expect("the child wrote its outcome");
    assert_eq!(outcome, "0", "the fork launch exits 0");

    // The source is untouched and both sessions stay hosted (resident
    // sessions outlive the client).
    let source_after = std::fs::read(&source).expect("read source");
    assert_eq!(source_before, source_after, "the source file is unchanged");
    let roster = daemon_roster(&socket).await;
    let canonical: Vec<_> = roster
        .iter()
        .map(|(file, _)| pa_daemon::lease::canonical_session_path(file))
        .collect();
    assert!(
        canonical.contains(&source_canonical),
        "the hosted source survives the fork"
    );
    let fork_canonical = pa_daemon::lease::canonical_session_path(&fork_file);
    assert!(
        canonical.contains(&fork_canonical),
        "the fork stays hosted after the client exits"
    );
    drop(child);
    drop(supervisor);
}
