use super::*;
use crate::protocol::{response_failure, response_success};
use pa_types::platform::transport::bind_transport;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

/// The gated fake supervisor: every `create` reports itself through
/// `create_seen_tx` and then parks until the shared verdict channel
/// answers `true` (the admission succeeds) or `false` (the admission
/// fails). Everything else answers like the watcher tests' scripted
/// supervisor: a prompt is admitted, the child goes idle with a final
/// answer, and a kill succeeds.
async fn spawn_gated_supervisor(
    socket: std::path::PathBuf,
    create_seen_tx: mpsc::UnboundedSender<Value>,
    verdict_rx: mpsc::UnboundedReceiver<bool>,
) {
    let verdict_rx = std::sync::Arc::new(tokio::sync::Mutex::new(verdict_rx));
    let listener = bind_transport(&socket).await.unwrap();
    tokio::spawn(async move {
        loop {
            let Ok(stream) = listener.accept().await else {
                return;
            };
            let create_seen_tx = create_seen_tx.clone();
            let verdict_rx = std::sync::Arc::clone(&verdict_rx);
            tokio::spawn(async move {
                let (reader, mut writer) = stream.split();
                let mut reader = BufReader::new(reader);
                writer
                    .write_all(
                        b"{\"type\":\"daemon_hello\",\"protocol\":{\"name\":\"prime-agent.daemon\",\"version\":7}}\n",
                    )
                    .await
                    .unwrap();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).await.unwrap() == 0 {
                        return;
                    }
                    let value: Value = serde_json::from_str(line.trim()).unwrap();
                    let id = value["id"].as_str().unwrap_or_default().to_string();
                    let command = value["command"].clone();
                    let command_type: &str = command["type"].as_str().unwrap_or_default();
                    let response = match command_type {
                        "create" => {
                            let _ = create_seen_tx.send(command.clone());
                            let verdict = verdict_rx.lock().await.recv().await;
                            match verdict {
                                Some(true) => {
                                    // The real supervisor echoes the
                                    // requested name in its create
                                    // summary; the record takes the
                                    // supervisor's answer over the
                                    // request, so the fake must echo
                                    // too or the registry never sees
                                    // the spawned name.
                                    let session_name = command["name"].as_str().unwrap_or_default();
                                    response_success(
                                        Some(&id),
                                        command_type,
                                        Some(json!({
                                            "activeSessionId": "child-live",
                                            "sessionId": "child-file",
                                            "sessionFile": "/tmp/child.jsonl",
                                            "sessionName": session_name,
                                        })),
                                    )
                                }
                                _ => response_failure(
                                    Some(&id),
                                    command_type,
                                    "create refused by the gated supervisor",
                                    None,
                                ),
                            }
                        }
                        "prompt" | "wait_for_idle" => {
                            response_success(Some(&id), command_type, None)
                        }
                        "get_state" => response_success(
                            Some(&id),
                            command_type,
                            Some(json!({
                                "isStreaming": false,
                                "sessionActions": { "queuedCount": 0 },
                            })),
                        ),
                        "get_last_assistant_text" => response_success(
                            Some(&id),
                            command_type,
                            Some(json!({ "text": "the child final answer" })),
                        ),
                        "kill" => response_success(Some(&id), command_type, None),
                        "follow_up" => response_success(
                            Some(&id),
                            command_type,
                            Some(json!({ "queued": true })),
                        ),
                        other => response_failure(Some(&id), other, "unexpected command", None),
                    };
                    let mut line = serde_json::to_string(&response).unwrap();
                    line.push('\n');
                    if writer.write_all(line.as_bytes()).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
}

/// Children registry against the gated fake supervisor.
async fn sessions_with_gated_supervisor(
    create_seen_tx: mpsc::UnboundedSender<Value>,
    verdict_rx: mpsc::UnboundedReceiver<bool>,
) -> SupervisorChildSessions {
    let socket = std::env::temp_dir().join(format!(
        "pa-rlm-gate-{}.sock",
        uuid::Uuid::new_v4().simple()
    ));
    spawn_gated_supervisor(socket.clone(), create_seen_tx, verdict_rx).await;
    let link = Arc::new(crate::supervisor_link::SupervisorLink::new(socket));
    let sessions = SupervisorChildSessions::new(
        link,
        std::env::temp_dir(),
        "parent-live".to_string(),
        std::sync::Arc::new(crate::model_allowlist::ModelRefusalTelemetry::new(
            std::env::temp_dir(),
            /*telemetry_disabled*/ true,
        )),
    );
    sessions.set_identity(ParentIdentity {
        model: Some("mock/mock-1".to_string()),
        cwd: Some(std::env::temp_dir().to_string_lossy().to_string()),
        ..ParentIdentity::with_default_depth()
    });
    sessions
}

fn spawn_request(name: &str, prompt: &str) -> RlmSpawnRequest {
    RlmSpawnRequest {
        prompt: prompt.to_string(),
        name: Some(name.to_string()),
        model: None,
        thinking: None,
        cell_source_code: None,
        spawned_by_request_id: None,
    }
}

/// The reservation lifecycle (TS's own test sequence): the name is
/// held across the parked admission - a racing same-name spawn fails
/// closed with the TS unavailability error - and freed at the
/// admission settle, after which the live registry owns the name and
/// a respawn fails on the registry check with the same error.
#[tokio::test]
async fn holds_a_spawn_name_reservation_until_admission_settles_then_frees_it() {
    let (create_seen_tx, mut create_seen_rx) = mpsc::unbounded_channel();
    let (verdict_tx, verdict_rx) = mpsc::unbounded_channel();
    let sessions = sessions_with_gated_supervisor(create_seen_tx, verdict_rx).await;
    let unavailable = "Agent name \"slow-worker\" is unavailable: an agent of that name already exists at depth 1 under this parent";

    // The first spawn parks inside its create admission.
    let spawned = tokio::spawn(sessions.spawn(spawn_request("slow-worker", "a slow admission")));
    create_seen_rx
        .recv()
        .await
        .expect("the create must reach the gated supervisor");
    assert!(sessions.spawn_name_reserved("slow-worker"));

    // A racing same-name spawn fails closed - the reservation, not the
    // registry, rejects it before any create reaches the supervisor.
    let racing = sessions
        .spawn(spawn_request("slow-worker", "a racing spawn"))
        .await
        .expect_err("the racing same-name spawn must fail closed");
    assert_eq!(racing.to_string(), unavailable);

    // The parked admission completes: the name transfers from the
    // pending reservation to the live registry.
    verdict_tx.send(true).expect("admit the parked create");
    let handle = spawned.await.expect("spawn task").expect("spawn admission");
    assert_eq!(handle.name, "slow-worker");
    assert!(!sessions.spawn_name_reserved("slow-worker"));

    // The admitted child owns the name: a respawn fails on the live
    // registry check with the same TS error.
    let respawn = sessions
        .spawn(spawn_request("slow-worker", "respawn while retained"))
        .await
        .expect_err("the admitted child owns the name");
    assert_eq!(respawn.to_string(), unavailable);
}

/// A cancelled admission frees the reserved name: the boxed
/// `RlmHostFuture` is a cancellable future, so the kernel can drop a
/// spawn mid-admission - the reservation must release with the future
/// or every later same-name spawn is rejected for the host's
/// lifetime.
#[tokio::test]
async fn a_cancelled_spawn_admission_frees_the_reserved_name() {
    let (create_seen_tx, mut create_seen_rx) = mpsc::unbounded_channel();
    let (verdict_tx, verdict_rx) = mpsc::unbounded_channel();
    let sessions = sessions_with_gated_supervisor(create_seen_tx, verdict_rx).await;

    // The spawn parks inside its create admission.
    let parked = tokio::spawn(sessions.spawn(spawn_request("abandoned", "a parked admission")));
    create_seen_rx
        .recv()
        .await
        .expect("the create must reach the gated supervisor");
    assert!(sessions.spawn_name_reserved("abandoned"));

    // The host future is cancelled mid-admission: the reservation
    // must release with the future.
    parked.abort();
    let _ = parked.await;
    assert!(!sessions.spawn_name_reserved("abandoned"));

    // The abandoned create's handler still holds the gated
    // supervisor's verdict gate on its dead connection; hand it a
    // failure to retire it, then queue the retry's admission.
    verdict_tx.send(false).expect("retire the abandoned create");
    verdict_tx.send(true).expect("admit the retry");
    let handle = sessions
        .spawn(spawn_request("abandoned", "retry after cancellation"))
        .await
        .expect("the freed name admits again");
    assert_eq!(handle.name, "abandoned");
    assert!(!sessions.spawn_name_reserved("abandoned"));
}

/// The failure path: a failed admission (the create errors after the
/// reservation was held) frees the name, so the same name spawns
/// again.
#[tokio::test]
async fn a_failed_admission_frees_the_reserved_name() {
    let (create_seen_tx, mut create_seen_rx) = mpsc::unbounded_channel();
    let (verdict_tx, verdict_rx) = mpsc::unbounded_channel();
    let sessions = sessions_with_gated_supervisor(create_seen_tx, verdict_rx).await;

    let spawned = tokio::spawn(sessions.spawn(spawn_request("doomed", "kernel startup failed")));
    create_seen_rx
        .recv()
        .await
        .expect("the create must reach the gated supervisor");
    assert!(sessions.spawn_name_reserved("doomed"));
    verdict_tx.send(false).expect("fail the admission");
    spawned
        .await
        .expect("spawn task")
        .expect_err("the failed admission surfaces");
    assert!(!sessions.spawn_name_reserved("doomed"));

    // The failed admission freed the name: the same name spawns again.
    verdict_tx.send(true).expect("admit the retry");
    let handle = sessions
        .spawn(spawn_request("doomed", "retry after the failure"))
        .await
        .expect("the freed name spawns again");
    assert_eq!(handle.name, "doomed");
    assert!(!sessions.spawn_name_reserved("doomed"));
}
