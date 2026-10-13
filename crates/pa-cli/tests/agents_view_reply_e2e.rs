// Tier-C/D ruling (fleet-uniform, 2026-09-28): large_futures stack by design on hot
// paths; too_many_lines is a style gate; casts narrow bounded OS/protocol values.
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

//! E2E verifier for the agents-view reply composer: the space-armed composer sends a
//! live session's reply through the UNATTACHED roster client (the view never attaches),
//! and a saved row resumes into a fresh session whose file carries the reply.
#![cfg(unix)]

use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use pa_tui::agents_view::{AgentsHeadlessPlan, AgentsStep, AgentsViewOptions, AgentsViewUiMode};

struct Supervisor {
    child: Child,
    #[allow(dead_code)]
    socket: PathBuf,
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        graceful_shutdown(&self.socket);
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.socket);
    }
}

fn graceful_shutdown(socket: &Path) {
    let Ok(stream) = UnixStream::connect(socket) else {
        return;
    };
    let Ok(write_half) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(stream);
    let mut writer = write_half;
    let mut hello = String::new();
    let _ = reader.read_line(&mut hello); // daemon_hello
    let command = serde_json::json!({
        "type": "command",
        "id": "test-shutdown",
        "protocol": { "name": "prime-agent.daemon", "version": 7 },
        "command": { "type": "shutdown" },
    });
    let Ok(mut line) = serde_json::to_string(&command) else {
        return;
    };
    line.push('\n');
    let _ = writer.write_all(line.as_bytes());
    let _ = writer.flush();
    let _ = reader
        .get_ref()
        .set_read_timeout(Some(Duration::from_secs(5)));
    let mut response = String::new();
    let _ = reader.read_line(&mut response);
}

#[allow(clippy::zombie_processes)]
fn spawn_supervisor(dir: &Path) -> Supervisor {
    let socket = dir.join("daemon.sock");
    let agent_dir = dir.join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let mut command = Command::new(env!("CARGO_BIN_EXE_prime-agent"));
    command
        .args(["--mode", "daemon", "--daemon-socket"])
        .arg(&socket)
        .env("PRIME_AGENT_CODING_AGENT_DIR", &agent_dir)
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
    ] {
        command.env_remove(var);
    }
    command.env(
        pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
        "15000",
    );
    let child = command.spawn().expect("spawn prime-agent --mode daemon");
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if socket.exists() {
            return Supervisor { child, socket };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("supervisor socket never appeared");
}

fn write_fixture(dir: &Path, id: &str, name: &str, turns: &[(&str, &str)]) -> PathBuf {
    let path = dir.join(format!("{id}.jsonl"));
    let mut content = format!(
        "{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"cwd\":\"/tmp\"}}\n"
    );
    let _ = writeln!(content,
        "{{\"type\":\"session_info\",\"id\":\"{id}-info\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"name\":\"{name}\"}}"
    );
    for (index, (user, assistant)) in turns.iter().enumerate() {
        let _ = writeln!(content,
            "{{\"type\":\"message\",\"id\":\"{id}-m{index}u\",\"timestamp\":\"2024-01-01T00:00:0{index}.000Z\",\"message\":{{\"role\":\"user\",\"content\":\"{user}\",\"timestamp\":{}}}}}",
            index * 1000
        );
        let _ = writeln!(content,
            "{{\"type\":\"message\",\"id\":\"{id}-m{index}a\",\"timestamp\":\"2024-01-01T00:00:0{index}.000Z\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"{assistant}\"}}],\"timestamp\":{}}}}}",
            index * 1000 + 1
        );
    }
    std::fs::write(&path, content).expect("write fixture");
    path
}

fn ask(socket: &Path, command: &serde_json::Value) -> Option<serde_json::Value> {
    let stream = UnixStream::connect(socket).ok()?;
    let write_half = stream.try_clone().ok()?;
    let mut reader = BufReader::new(stream);
    let mut writer = write_half;
    let mut hello = String::new();
    reader.read_line(&mut hello).ok()?;
    let mut line = serde_json::to_string(&serde_json::json!({
        "type": "command",
        "id": "reply-e2e-ask",
        "protocol": { "name": "prime-agent.daemon", "version": 7 },
        "command": command,
    }))
    .ok()?;
    line.push('\n');
    writer.write_all(line.as_bytes()).ok()?;
    writer.flush().ok()?;
    reader
        .get_ref()
        .set_read_timeout(Some(Duration::from_secs(10)))
        .ok()?;
    let mut response = String::new();
    reader.read_line(&mut response).ok()?;
    serde_json::from_str(&response).ok()
}

/// The create config pointing at the faux engine's script: the send path runs
/// through the REAL agent engine with real session persistence.
fn faux_engine_config(dir: &Path, responses: &[&str]) -> serde_json::Value {
    let script = dir.join("faux-engine.json");
    std::fs::write(
        &script,
        serde_json::json!({
            "engine": "faux",
            "responses": responses
                .iter()
                .map(|text| serde_json::json!({ "text": text }))
                .collect::<Vec<_>>(),
        })
        .to_string(),
    )
    .expect("write faux script");
    serde_json::json!({ "script": script.to_string_lossy() })
}

fn view_options(socket: &Path, session_dir: &Path, config: serde_json::Value) -> AgentsViewOptions {
    AgentsViewOptions {
        socket_path: socket.to_path_buf(),
        cwd: std::env::temp_dir(),
        session_dir: Some(session_dir.to_path_buf()),
        theme: "prime".to_string(),
        version: "0.0.0".to_string(),
        anchor_session_id: None,
        scope: None,
        query: None,
        expanded_ancestors: Vec::new(),
        selected_row_identity: None,
        selected_key: None,
        status_message: None,
        keybindings: pa_tui::keybindings::KeybindingsManager::new(),
        show_hardware_cursor: false,
        incident_notice_state: None,
        create_config: config,
    }
}

#[tokio::test]
async fn reply_to_live_session_delivers_the_prompt() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());
    // Two scripted responses: the warm-up turn consumes the first, the view's reply the second.
    let config = faux_engine_config(dir.path(), &["warm reply", "the reply landed"]);

    // Create through the daemon: the roster row the view lists must exist.
    let created = ask(
        &supervisor.socket,
        &serde_json::json!({ "type": "create", "config": config }),
    )
    .expect("the create answered")
    .get("data")
    .cloned()
    .expect("the create returned the summary");
    let active = created
        .get("activeSessionId")
        .and_then(serde_json::Value::as_str)
        .expect("the created session is live")
        .to_string();
    // The raw roster must carry the fresh worker before the view runs.
    let roster_carries = |tries: usize| {
        (0..tries).any(|attempt| {
            if attempt > 0 {
                std::thread::sleep(Duration::from_millis(200));
            }
            ask(
                &supervisor.socket,
                &serde_json::json!({ "type": "roster_subscribe" }),
            )
            .is_some_and(|response| {
                response
                    .get("data")
                    .and_then(|data| data.get("roster"))
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(|roster| {
                        roster.iter().any(|entry| {
                            entry
                                .get("summary")
                                .and_then(|summary| summary.get("activeSessionId"))
                                .and_then(serde_json::Value::as_str)
                                == Some(active.as_str())
                        })
                    })
            })
        })
    };
    assert!(
        roster_carries(50),
        "the raw roster never carried the created session"
    );
    // A message-less draft never surfaces as a roster row (TS
    // `shouldShowAgentsViewSession`), so the reply target needs a live session with
    // a first exchange; the warm-up must complete before the view runs.
    let warmed = ask(
        &supervisor.socket,
        &serde_json::json!({
            "type": "prompt",
            "activeSessionId": active,
            "message": "warm up",
        }),
    );
    assert!(
        warmed.is_some_and(|r| r.get("success") == Some(&serde_json::json!(true))),
        "the warm-up prompt ran"
    );
    let session_is_live = |tries: usize| {
        (0..tries).any(|attempt| {
            if attempt > 0 {
                std::thread::sleep(Duration::from_millis(200));
            }
            ask(
                &supervisor.socket,
                &serde_json::json!({ "type": "roster_subscribe" }),
            )
            .is_some_and(|response| {
                response
                    .get("data")
                    .and_then(|data| data.get("roster"))
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(|roster| {
                        roster.iter().any(|entry| {
                            entry.get("summary").is_some_and(|summary| {
                                summary
                                    .get("activeSessionId")
                                    .and_then(serde_json::Value::as_str)
                                    == Some(active.as_str())
                                    && summary.get("lifecycle").and_then(serde_json::Value::as_str)
                                        == Some("live")
                            })
                        })
                    })
            })
        })
    };
    assert!(
        session_is_live(50),
        "the warm-up never made the session live"
    );

    let options = view_options(&supervisor.socket, &session_dir, config);
    let plan = AgentsHeadlessPlan {
        steps: vec![
            AgentsStep::WaitSettle { timeout_ms: 1000 },
            // The live row sits at the top of the Idle section.
            AgentsStep::Key("space".to_string()),
            AgentsStep::Type("ping".to_string()),
            AgentsStep::Key("enter".to_string()),
            AgentsStep::WaitRender {
                needle: "Reply sent".to_string(),
                timeout_ms: 10_000,
            },
        ],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::agents_view::run_agents_view(options, AgentsViewUiMode::Headless(plan), None)
            .await
            .expect("agents view run")
            .outcome;
    let rendered = outcome.frames.join("\n");
    assert!(
        rendered.contains("Reply sent"),
        "the send's status rendered ({} frames):\n{rendered}",
        outcome.frames.len()
    );
    // The reply's turn runs behind the send's ack: poll until its scripted answer lands.
    let mut last = String::new();
    let reply_landed = (0..50).any(|attempt| {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(200));
        }
        last = ask(
            &supervisor.socket,
            &serde_json::json!({ "type": "get_last_assistant_text", "activeSessionId": active }),
        )
        .and_then(|response| {
            response
                .get("data")
                .and_then(|data| data.get("text"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();
        last.contains("the reply landed")
    });
    assert!(
        reply_landed,
        "the reply delivered to the live session (last assistant: {last:?})"
    );
}

#[tokio::test]
async fn reply_to_saved_session_resumes_and_sends() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let supervisor = spawn_supervisor(dir.path());
    let config = faux_engine_config(dir.path(), &["resumed and heard"]);

    let fixture = write_fixture(
        &session_dir,
        "resume-01",
        "resume target",
        &[("first turn", "first reply")],
    );

    let options = view_options(&supervisor.socket, &session_dir, config);
    let plan = AgentsHeadlessPlan {
        steps: vec![
            AgentsStep::WaitSettle { timeout_ms: 1000 },
            // The saved row is the Inactive section's only row.
            AgentsStep::Key("space".to_string()),
            AgentsStep::WaitRender {
                needle: "Write a prompt to resume this session".to_string(),
                timeout_ms: 5000,
            },
            AgentsStep::Type("resume me".to_string()),
            AgentsStep::Key("enter".to_string()),
            AgentsStep::WaitRender {
                needle: "Reply sent".to_string(),
                timeout_ms: 15_000,
            },
        ],
        width: 120,
        height: 36,
    };
    let outcome =
        pa_tui::agents_view::run_agents_view(options, AgentsViewUiMode::Headless(plan), None)
            .await
            .expect("agents view run")
            .outcome;
    let rendered = outcome.frames.join("\n");
    assert!(
        rendered.contains("Reply sent"),
        "the resume's status rendered:\n{rendered}"
    );
    // The resumed session appends to the SAME durable file, persisting behind the
    // send's ack — poll until it lands.
    let mut content = String::new();
    let reply_persisted = (0..50).any(|attempt| {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(200));
        }
        content = std::fs::read_to_string(&fixture).unwrap_or_default();
        content.contains("resume me")
    });
    assert!(
        reply_persisted,
        "the resumed session's file holds the reply:\n{content}"
    );
    let list = ask(&supervisor.socket, &serde_json::json!({ "type": "list" }))
        .expect("the list answered")
        .get("data")
        .and_then(|data| data.get("sessions"))
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let live_for_fixture = list.iter().any(|session| {
        session
            .get("sessionFile")
            .and_then(serde_json::Value::as_str)
            == Some(fixture.to_string_lossy().as_ref())
    });
    assert!(
        live_for_fixture,
        "the fixture resumed into a live session (list: {list:?})"
    );
}
