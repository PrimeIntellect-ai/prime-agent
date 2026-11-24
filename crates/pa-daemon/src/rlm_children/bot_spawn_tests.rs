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

/// A fake supervisor that serves the bot commands and records them. Once
/// `running_reads` is set, the bot stays running for that many more
/// `list_bots` reads, then pauses.
async fn fake_supervisor(
    commands: Arc<std::sync::Mutex<Vec<Value>>>,
    running_reads: Arc<std::sync::Mutex<Option<usize>>>,
) -> std::path::PathBuf {
    let socket = std::env::temp_dir().join(format!(
        "pa-bot-spawn-{}.sock",
        uuid::Uuid::new_v4().simple()
    ));
    let listener = bind_transport(&socket).await.unwrap();
    tokio::spawn(async move {
        while let Ok(stream) = listener.accept().await {
            let commands = Arc::clone(&commands);
            let running_reads = Arc::clone(&running_reads);
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
                            let mut bot = bot_row();
                            match running_reads.lock().unwrap().as_mut() {
                                Some(0) => bot["status"] = json!("paused"),
                                Some(reads) => *reads -= 1,
                                None => {}
                            }
                            let bots = if deleted { vec![] } else { vec![bot] };
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
    let running_reads = Arc::new(std::sync::Mutex::new(None));
    let socket = fake_supervisor(Arc::clone(&commands), Arc::clone(&running_reads)).await;
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
    // A waiting collect re-reads the bot until its turn ends.
    *running_reads.lock().unwrap() = Some(1);
    let collected = sessions
        .collect(vec!["scout".to_string()], 10_000)
        .await
        .unwrap();
    assert_eq!(collected[0].status, "done");
    let roster = sessions.list_subagents().await.unwrap();
    assert_eq!(roster[0].status, "paused");
    // A factory state cannot spawn a bot: its ledger edge would be lost.
    let tagged = RlmSpawnRequest {
        factory: Some(pa_core::session_engine::rlm_host::RlmFactoryTag {
            run_id: "run-1".to_string(),
            spec_id: "spec-1".to_string(),
            state_id: "state-1".to_string(),
        }),
        ..request("scout-2", RlmSpawnTarget::Sandbox)
    };
    let refused = sessions.spawn(tagged).await.expect_err("no factory bot");
    assert!(refused.to_string().contains("factory"), "{refused}");
    // A local child cannot take the bot's name.
    let refused = sessions
        .spawn(request("scout", RlmSpawnTarget::Local))
        .await
        .expect_err("the bot holds the name");
    assert!(refused.to_string().contains("scout"), "{refused}");

    // A collect that waits on a running bot settles from the tombstone
    // when the bot is deleted meanwhile.
    *running_reads.lock().unwrap() = None;
    let (collected, deleted) = tokio::join!(
        sessions.collect(
            vec![bot_row()["botId"].as_str().unwrap().to_string()],
            60_000
        ),
        sessions.delete_subagent("scout".to_string()),
    );
    assert!(collected.unwrap()[0].settled);
    let deleted = deleted.unwrap();
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
