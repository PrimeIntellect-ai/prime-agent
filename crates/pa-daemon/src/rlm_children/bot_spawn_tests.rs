//! `rlm.spawn(target="sandbox")` from the worker: the spawn, roster,
//! collect, and delete reach the supervisor's bot commands, and a bot
//! name blocks a local child of the same name.

use super::*;
use crate::protocol::{response_failure, response_success};
use pa_core::session_engine::rlm_host::RlmSpawnTarget;
use pa_types::platform::transport::bind_transport;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

fn bot_row() -> Value {
    json!({
        "botId": "0b0b0b0b-0000-4000-8000-000000000001",
        "name": "scout",
        "ownerSessionId": "parent-file",
        "sandboxId": "sb-1",
        "status": "running",
        "model": "mock/mock-1",
        "version": "0.0.0",
        "guestSessionId": "guest-1",
        "attached": false,
    })
}

/// A fake supervisor that serves the bot commands and records them.
async fn fake_supervisor(commands: Arc<std::sync::Mutex<Vec<Value>>>) -> std::path::PathBuf {
    let socket = std::env::temp_dir().join(format!(
        "pa-bot-spawn-{}.sock",
        uuid::Uuid::new_v4().simple()
    ));
    let listener = bind_transport(&socket).await.unwrap();
    tokio::spawn(async move {
        while let Ok(stream) = listener.accept().await {
            let commands = Arc::clone(&commands);
            tokio::spawn(async move {
                let (reader, mut writer) = stream.split();
                let mut reader = BufReader::new(reader);
                writer
                    .write_all(b"{\"type\":\"daemon_hello\",\"protocol\":{\"name\":\"prime-agent.daemon\",\"version\":7}}\n")
                    .await
                    .unwrap();
                let mut line = String::new();
                while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                    let value: Value = serde_json::from_str(line.trim()).unwrap();
                    line.clear();
                    let id = value["id"].as_str().unwrap_or_default().to_string();
                    let command = value["command"].clone();
                    let kind = command["type"].as_str().unwrap_or_default().to_string();
                    commands.lock().unwrap().push(command);
                    let response = match kind.as_str() {
                        "spawn_bot" | "delete_bot" => {
                            response_success(Some(&id), &kind, Some(bot_row()))
                        }
                        "list_bots" => {
                            // A deleted bot leaves the supervisor's list.
                            let deleted = commands
                                .lock()
                                .unwrap()
                                .iter()
                                .any(|command| command["type"] == "delete_bot");
                            let bots = if deleted { vec![] } else { vec![bot_row()] };
                            response_success(Some(&id), &kind, Some(json!({ "bots": bots })))
                        }
                        other => response_failure(Some(&id), other, "unexpected command", None),
                    };
                    let mut out = serde_json::to_string(&response).unwrap();
                    out.push('\n');
                    if writer.write_all(out.as_bytes()).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    socket
}

fn request(name: &str, target: RlmSpawnTarget) -> RlmSpawnRequest {
    RlmSpawnRequest {
        target,
        prompt: "scout the repo".to_string(),
        name: Some(name.to_string()),
        model: None,
        thinking: None,
        kind: pa_core::session_engine::rlm_host::RlmSpawnKind::Subagent,
        cwd: None,
        spawned_by_request_id: None,
        factory: None,
    }
}

#[tokio::test]
async fn a_sandbox_spawn_is_a_bot_on_the_supervisor() {
    let commands = Arc::new(std::sync::Mutex::new(Vec::new()));
    let socket = fake_supervisor(Arc::clone(&commands)).await;
    let sessions = SupervisorChildSessions::new(
        Arc::new(crate::supervisor_link::SupervisorLink::new(socket)),
        std::env::temp_dir(),
        "parent-live".to_string(),
        Arc::new(crate::model_allowlist::ModelRefusalTelemetry::new(
            std::env::temp_dir(),
            /*telemetry_disabled*/ true,
        )),
        String::new(),
    );
    sessions.set_identity(ParentIdentity {
        session_id: Some("parent-file".to_string()),
        model: Some("mock/mock-1".to_string()),
        cwd: Some(std::env::temp_dir().to_string_lossy().to_string()),
        ..ParentIdentity::with_default_depth()
    });

    let handle = sessions
        .spawn(request("scout", RlmSpawnTarget::Sandbox))
        .await
        .expect("the bot spawn admits");
    assert_eq!(handle.rlm_child_id, bot_row()["botId"]);
    assert_eq!(handle.name, "scout");
    assert_eq!(handle.model, "mock/mock-1");
    let spawn = commands.lock().unwrap()[0].clone();
    assert_eq!(spawn["type"], "spawn_bot");
    assert_eq!(spawn["ownerSessionId"], "parent-file");
    assert_eq!(spawn["prompt"], "scout the repo");
    assert_eq!(spawn["rlmMaxDepth"], DEFAULT_RLM_MAX_DEPTH - 1);
    assert!(!sessions.spawn_name_reserved("scout"));

    // The bot shows on the roster and in collect, and deletes through
    // the supervisor.
    let roster = sessions.list_subagents().await.unwrap();
    assert_eq!(roster.len(), 1);
    assert_eq!(roster[0].session_name, "scout");
    assert_eq!(roster[0].status, "running");
    let collected = sessions
        .collect(vec!["scout".to_string()], 0)
        .await
        .unwrap();
    assert_eq!(collected.len(), 1);
    assert!(!collected[0].settled);
    // A local child cannot take the bot's name.
    let refused = sessions
        .spawn(request("scout", RlmSpawnTarget::Local))
        .await
        .expect_err("the bot holds the name");
    assert!(refused.to_string().contains("scout"), "{refused}");

    let deleted = sessions.delete_subagent("scout".to_string()).await.unwrap();
    assert_eq!(deleted.outcome, Some("deleted"));
    assert!(commands.lock().unwrap().iter().any(
        |command| command["type"] == "delete_bot" && command["ownerSessionId"] == "parent-file"
    ));
    // The supervisor forgot the bot; a repeated delete and a collect
    // still answer from the tombstone.
    let again = sessions.delete_subagent("scout".to_string()).await.unwrap();
    assert_eq!(again.subagent.status, "cancelled");
    let collected = sessions
        .collect(vec!["scout".to_string()], 0)
        .await
        .unwrap();
    assert!(collected[0].settled);
}
