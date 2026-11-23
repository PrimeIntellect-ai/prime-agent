//! Bot guest outbox e2e: a guest daemon started with `PRIME_AGENT_REMOTE_PARENT`
//! shows the owner as the one parent; a send to it is queued in the durable
//! outbox, and `read_remote_parent` serves it, also after a guest restart.
//! Linux-only e2e (`AF_UNIX` sockets), like the other pa-daemon verifiers.
#![allow(clippy::large_futures)]
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use pa_core::kernel::shared::{HostRequestHandlers, HostRequestPayload};
use pa_core::session_engine::agent_messaging::register_agent_message_host_handlers;
use pa_daemon::agent_messaging::LinkAgentMessageController;
use pa_daemon::supervisor_link::SupervisorLink;
use serde_json::{json, Value};

struct Daemon(Child);

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn spawn_guest(socket: &Path, agent_dir: &Path) -> Daemon {
    let _ = std::fs::remove_file(socket);
    let child = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .args(["supervisor", "--socket"])
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .env("PRIME_AGENT_REMOTE_PARENT", "owner")
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn pa-daemon supervisor");
    let deadline = Instant::now() + Duration::from_secs(15);
    while UnixStream::connect(socket).is_err() {
        assert!(Instant::now() < deadline, "guest socket never came up");
        std::thread::sleep(Duration::from_millis(20));
    }
    Daemon(child)
}

/// One command on a fresh connection; the response `data`.
fn command(socket: &Path, command: &Value) -> Value {
    let stream = UnixStream::connect(socket).expect("connect guest");
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .expect("read timeout");
    let mut writer = stream.try_clone().expect("clone");
    let mut reader = BufReader::new(stream);
    let envelope = json!({
        "type": "command",
        "id": "c1",
        "protocol": { "name": "prime-agent.daemon", "version": 7 },
        "command": command,
    });
    writer
        .write_all(format!("{envelope}\n").as_bytes())
        .expect("send");
    let mut line = String::new();
    loop {
        line.clear();
        reader.read_line(&mut line).expect("read");
        let value: Value = serde_json::from_str(line.trim()).expect("parse line");
        if value["id"] == "c1" {
            assert_eq!(value["success"], true, "{command} failed: {value}");
            return value["data"].clone();
        }
    }
}

fn worker_token(agent_dir: &Path, active_session_id: &str) -> String {
    for instance in std::fs::read_dir(agent_dir.join("daemon-workers"))
        .expect("daemon-workers")
        .flatten()
    {
        let path = instance.path().join(format!("{active_session_id}.json"));
        if let Ok(text) = std::fs::read_to_string(path) {
            let descriptor: Value = serde_json::from_str(&text).expect("descriptor");
            return descriptor["authenticationToken"]
                .as_str()
                .expect("token")
                .to_string();
        }
    }
    panic!("worker descriptor not found");
}

fn outbox(socket: &Path, after_seq: u64) -> Vec<Value> {
    command(
        socket,
        &json!({ "type": "read_remote_parent", "afterSeq": after_seq }),
    )["entries"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

#[tokio::test]
async fn a_bot_message_to_its_owner_is_queued_durably() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("guest.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(agent_dir.join("sessions")).expect("sessions dir");
    let script = dir.path().join("bot.json");
    std::fs::write(
        &script,
        json!({ "engine": "faux", "responses": [{ "text": "ok" }] }).to_string(),
    )
    .expect("faux script");
    // The worker-side controller runs in this process: it reads the same
    // environment a guest daemon's workers inherit.
    std::env::set_var("PRIME_AGENT_REMOTE_PARENT", "owner");
    std::env::set_var(pa_daemon::paths::AGENT_DIR_ENV, &agent_dir);

    let guest = spawn_guest(&socket, &agent_dir);
    let created = command(
        &socket,
        &json!({
            "type": "create",
            "name": "bot",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                "script": script.to_string_lossy(),
            },
        }),
    );
    let active = created["activeSessionId"]
        .as_str()
        .or_else(|| created["id"].as_str())
        .expect("bot active session id")
        .to_string();
    let controller = Arc::new(LinkAgentMessageController::new(
        Arc::new(SupervisorLink::new(socket.clone())),
        active.clone(),
        worker_token(&agent_dir, &active),
        Arc::new(std::sync::Mutex::new(Some(json!({
            "activeSessionId": active,
            "sessionName": "bot",
            "runtimeKind": "top-level",
        })))),
        None,
    ));
    let mut handlers = HostRequestHandlers::default();
    register_agent_message_host_handlers(Arc::clone(&controller) as Arc<_>, &mut handlers);
    let send = handlers.get("agent_message.send").expect("send handler");
    let receipt = send(HostRequestPayload {
        data: json!({ "message": "found it", "receiver_role": "parent" }),
    })
    .await
    .expect("send to the owner");
    assert_eq!(receipt["deliveryStatus"], "queued", "{receipt}");
    assert_eq!(receipt["target"]["sessionName"], "owner", "{receipt}");

    let entries = outbox(&socket, 0);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["seq"], 1);
    assert_eq!(entries[0]["message"], "found it");
    assert!(outbox(&socket, 1).is_empty());

    // A subagent whose recorded parent is not in the roster (restarting)
    // never falls back to the owner.
    let subagent = Arc::new(LinkAgentMessageController::new(
        Arc::new(SupervisorLink::new(socket.clone())),
        active.clone(),
        worker_token(&agent_dir, &active),
        Arc::new(std::sync::Mutex::new(Some(json!({
            "activeSessionId": active,
            "sessionName": "bot",
            "runtimeKind": "subagent",
            "parentSessionId": "restarting-parent",
        })))),
        None,
    ));
    let mut handlers = HostRequestHandlers::default();
    register_agent_message_host_handlers(subagent as Arc<_>, &mut handlers);
    let send = handlers.get("agent_message.send").expect("send handler");
    let _ = send(HostRequestPayload {
        data: json!({ "message": "for my parent", "receiver_role": "parent" }),
    })
    .await;
    assert_eq!(outbox(&socket, 0), entries);

    drop(guest);
    let _guest = spawn_guest(&socket, &agent_dir);
    assert_eq!(outbox(&socket, 0), entries);
}
