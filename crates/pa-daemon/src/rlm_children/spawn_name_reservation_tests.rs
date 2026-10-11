use super::*;
use crate::protocol::{response_failure, response_success};
use pa_types::platform::transport::bind_transport;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

/// The gated fake supervisor: every `create` reports through `create_seen_tx` and parks until the
/// shared verdict channel answers; everything else answers like the watcher tests' supervisor.
async fn spawn_gated_supervisor(
    socket: std::path::PathBuf,
    create_seen_tx: mpsc::UnboundedSender<Value>,
    verdict_rx: mpsc::UnboundedReceiver<bool>,
    rename_seen_tx: mpsc::UnboundedSender<Value>,
    rename_verdict_rx: Option<mpsc::UnboundedReceiver<()>>,
) {
    let verdict_rx = std::sync::Arc::new(tokio::sync::Mutex::new(verdict_rx));
    let rename_verdict_rx = rename_verdict_rx.map(|rx| Arc::new(tokio::sync::Mutex::new(rx)));
    let listener = bind_transport(&socket).await.unwrap();
    tokio::spawn(async move {
        loop {
            let Ok(stream) = listener.accept().await else {
                return;
            };
            let create_seen_tx = create_seen_tx.clone();
            let rename_seen_tx = rename_seen_tx.clone();
            let verdict_rx = std::sync::Arc::clone(&verdict_rx);
            let rename_verdict_rx = rename_verdict_rx.clone();
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
                                    // requested name; the record takes the
                                    // supervisor's answer over the request.
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
                        "rename" => {
                            let _ = rename_seen_tx.send(command.clone());
                            if let Some(gate) = &rename_verdict_rx {
                                let _ = gate.lock().await.recv().await;
                            }
                            response_success(Some(&id), command_type, None)
                        }
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
    rename_seen_tx: mpsc::UnboundedSender<Value>,
    rename_verdict_rx: Option<mpsc::UnboundedReceiver<()>>,
) -> SupervisorChildSessions {
    let socket = std::env::temp_dir().join(format!(
        "pa-rlm-gate-{}.sock",
        uuid::Uuid::new_v4().simple()
    ));
    spawn_gated_supervisor(
        socket.clone(),
        create_seen_tx,
        verdict_rx,
        rename_seen_tx,
        rename_verdict_rx,
    )
    .await;
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
        decision_child: false,
    }
}

/// The reservation lifecycle: the name is held across the parked admission — a racing same-name
/// spawn fails closed — and freed at the settle, after which the live registry owns the name.
#[tokio::test]
async fn holds_a_spawn_name_reservation_until_admission_settles_then_frees_it() {
    let (create_seen_tx, mut create_seen_rx) = mpsc::unbounded_channel();
    let (verdict_tx, verdict_rx) = mpsc::unbounded_channel();
    let (rename_seen_tx, _rename_seen_rx) = mpsc::unbounded_channel();
    let sessions =
        sessions_with_gated_supervisor(create_seen_tx, verdict_rx, rename_seen_tx, None).await;
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
/// `RlmHostFuture` is cancellable, so the reservation must release with it.
#[tokio::test]
async fn a_cancelled_spawn_admission_frees_the_reserved_name() {
    let (create_seen_tx, mut create_seen_rx) = mpsc::unbounded_channel();
    let (verdict_tx, verdict_rx) = mpsc::unbounded_channel();
    let (rename_seen_tx, _rename_seen_rx) = mpsc::unbounded_channel();
    let sessions =
        sessions_with_gated_supervisor(create_seen_tx, verdict_rx, rename_seen_tx, None).await;

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
/// reservation was held) frees the name, so the same name spawns again.
#[tokio::test]
async fn a_failed_admission_frees_the_reserved_name() {
    let (create_seen_tx, mut create_seen_rx) = mpsc::unbounded_channel();
    let (verdict_tx, verdict_rx) = mpsc::unbounded_channel();
    let (rename_seen_tx, _rename_seen_rx) = mpsc::unbounded_channel();
    let sessions =
        sessions_with_gated_supervisor(create_seen_tx, verdict_rx, rename_seen_tx, None).await;

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

    verdict_tx.send(true).expect("admit the retry");
    let handle = sessions
        .spawn(spawn_request("doomed", "retry after the failure"))
        .await
        .expect("the freed name spawns again");
    assert_eq!(handle.name, "doomed");
    assert!(!sessions.spawn_name_reserved("doomed"));
}

/// The rename target resolution (TS `renameAgentFamilySession`): a child
/// renames only by rlm child id, active id, or durable session id — a
/// name never selects — and a miss outside the caller's own session and
/// its direct children fails closed.
#[tokio::test]
async fn rename_resolves_child_targets_by_id_only() {
    let (create_seen_tx, mut create_seen_rx) = mpsc::unbounded_channel();
    let (verdict_tx, verdict_rx) = mpsc::unbounded_channel();
    let (rename_seen_tx, _rename_seen_rx) = mpsc::unbounded_channel();
    let sessions =
        sessions_with_gated_supervisor(create_seen_tx, verdict_rx, rename_seen_tx, None).await;
    let spawned = tokio::spawn(sessions.spawn(spawn_request("worker-a", "a named child")));
    create_seen_rx
        .recv()
        .await
        .expect("the create must reach the gated supervisor");
    verdict_tx.send(true).expect("admit the create");
    let _handle = spawned.await.expect("spawn task").expect("spawn the child");

    // The child's NAME never selects a rename target.
    let error = sessions
        .rename("bench-runner".to_string(), Some("worker-a".to_string()))
        .await
        .expect_err("a child name never renames");
    assert_eq!(
        error.to_string(),
        "rlm.rename session_id \"worker-a\" must be the full session id or a child handle, not a session name or id suffix"
    );
    // A selector outside the caller and its children fails closed.
    let error = sessions
        .rename("bench-runner".to_string(), Some("ghost".to_string()))
        .await
        .expect_err("an unknown target never renames");
    assert_eq!(
        error.to_string(),
        "rlm.rename can only rename the current session or one of its direct children"
    );
}

/// A parent-directed child rename rides the supervisor's live rename
/// route (`renamedBy: parent`), and on success the parent-side record
/// takes the new name — the old name stops matching, the new one hits.
#[tokio::test]
async fn parent_rename_forwards_and_reseeds_the_record_name() {
    let (create_seen_tx, mut create_seen_rx) = mpsc::unbounded_channel();
    let (verdict_tx, verdict_rx) = mpsc::unbounded_channel();
    let (rename_seen_tx, mut rename_seen_rx) = mpsc::unbounded_channel();
    let sessions =
        sessions_with_gated_supervisor(create_seen_tx, verdict_rx, rename_seen_tx, None).await;
    let spawned = tokio::spawn(sessions.spawn(spawn_request("worker-a", "a named child")));
    create_seen_rx
        .recv()
        .await
        .expect("the create must reach the gated supervisor");
    verdict_tx.send(true).expect("admit the create");
    let handle = spawned.await.expect("spawn task").expect("spawn the child");

    let renamed = sessions
        .rename(
            "bench-runner".to_string(),
            Some(handle.rlm_child_id.clone()),
        )
        .await
        .expect("rename the child by its handle id");
    assert_eq!(renamed, "bench-runner");
    let seen = rename_seen_rx
        .recv()
        .await
        .expect("the rename reached the supervisor");
    assert_eq!(seen["type"], "rename");
    assert_eq!(seen["activeSessionId"], "child-live");
    assert_eq!(seen["name"], "bench-runner");
    assert_eq!(
        seen["renamedBy"], "parent",
        "a child rename is parent-directed"
    );

    // The record took the new name: the old selector misses, the new one
    // hits (the collect-by-name and delete selectors read it).
    let error = sessions
        .collect(vec!["worker-a".to_string()], 0)
        .await
        .expect_err("the old name no longer selects");
    assert_eq!(
        error.to_string(),
        "No direct RLM child matches \"worker-a\" in the current parent session"
    );
    let rows = sessions
        .collect(vec!["bench-runner".to_string()], 0)
        .await
        .expect("the new name selects");
    assert_eq!(rows[0].rlm_child_id, handle.rlm_child_id);
}

/// A self rename (an absent session id, the caller's own active id, or
/// its durable session id) routes to the caller's own worker through the
/// supervisor with no `renamedBy` marker.
#[tokio::test]
async fn self_rename_targets_the_caller_without_the_parent_marker() {
    let (create_seen_tx, _create_seen_rx) = mpsc::unbounded_channel();
    let (_verdict_tx, verdict_rx) = mpsc::unbounded_channel();
    let (rename_seen_tx, mut rename_seen_rx) = mpsc::unbounded_channel();
    let sessions =
        sessions_with_gated_supervisor(create_seen_tx, verdict_rx, rename_seen_tx, None).await;
    sessions.set_identity(ParentIdentity {
        model: Some("mock/mock-1".to_string()),
        cwd: Some(std::env::temp_dir().to_string_lossy().to_string()),
        session_id: Some("parent-file".to_string()),
        ..ParentIdentity::with_default_depth()
    });

    for selector in [None, Some("parent-live"), Some("parent-file")] {
        let renamed = sessions
            .rename("solo".to_string(), selector.map(str::to_string))
            .await
            .expect("the self rename routes");
        assert_eq!(renamed, "solo");
        let seen = rename_seen_rx
            .recv()
            .await
            .expect("the rename reached the supervisor");
        assert_eq!(seen["type"], "rename");
        assert_eq!(seen["activeSessionId"], "parent-live");
        assert_eq!(seen["name"], "solo");
        assert!(
            seen.get("renamedBy").is_none(),
            "a self rename carries no parent marker: {seen}"
        );
    }
}

/// A second rename must not overtake the first command and then let its
/// earlier parent-side record write replace the final worker name.
#[tokio::test]
async fn concurrent_parent_renames_keep_the_last_applied_name() {
    let (create_seen_tx, mut create_seen_rx) = mpsc::unbounded_channel();
    let (verdict_tx, verdict_rx) = mpsc::unbounded_channel();
    let (rename_seen_tx, mut rename_seen_rx) = mpsc::unbounded_channel();
    let (rename_verdict_tx, rename_verdict_rx) = mpsc::unbounded_channel();
    let sessions = sessions_with_gated_supervisor(
        create_seen_tx,
        verdict_rx,
        rename_seen_tx,
        Some(rename_verdict_rx),
    )
    .await;
    let spawned = tokio::spawn(sessions.spawn(spawn_request("worker-a", "a named child")));
    create_seen_rx
        .recv()
        .await
        .expect("create reached the supervisor");
    verdict_tx.send(true).expect("admit create");
    let handle = spawned.await.expect("spawn task").expect("spawn child");

    let first =
        tokio::spawn(sessions.rename("first".to_string(), Some(handle.rlm_child_id.clone())));
    let seen = rename_seen_rx
        .recv()
        .await
        .expect("first rename reached supervisor");
    assert_eq!(seen["name"], "first");
    let second =
        tokio::spawn(sessions.rename("second".to_string(), Some(handle.rlm_child_id.clone())));
    // The second parent rename must wait before forwarding; the fake
    // supervisor deliberately parks the first reply.
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), rename_seen_rx.recv())
            .await
            .is_err()
    );
    rename_verdict_tx.send(()).expect("finish first rename");
    assert_eq!(
        first.await.expect("first task").expect("first rename"),
        "first"
    );
    let seen = rename_seen_rx
        .recv()
        .await
        .expect("second rename reached supervisor");
    assert_eq!(seen["name"], "second");
    rename_verdict_tx.send(()).expect("finish second rename");
    assert_eq!(
        second.await.expect("second task").expect("second rename"),
        "second"
    );
    let rows = sessions.list_subagents().await.expect("roster");
    assert_eq!(rows[0].session_name, "second");
}
