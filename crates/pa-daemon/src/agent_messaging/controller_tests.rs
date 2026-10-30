//! The controller test battery: family roster, direct peer delivery,
//! fallback, and observe families.

use super::observe::summaries_from_roster;
use super::*;
use crate::protocol::{response_failure, response_success};
use crate::rlm_children::RlmChildIdentity;
use crate::supervisor_link::SupervisorLink;
use pa_core::session_engine::agent_messaging::{AgentMessageController, AgentObserveController};
use pa_types::platform::transport::bind_transport;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// A scripted JSONL supervisor: answers `list` with a roster,
/// `get_worker_peer_transport` per script, and `send_message` with a
/// TS receipt.
async fn spawn_fake_supervisor(
    socket: std::path::PathBuf,
    roster: Value,
    ticket_response: Option<Value>,
) {
    let listener = bind_transport(&socket).await.unwrap();
    tokio::spawn(async move {
        loop {
            let Ok(stream) = listener.accept().await else {
                return;
            };
            let roster = roster.clone();
            let ticket_response = ticket_response.clone();
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
                    let command_type = command["type"].as_str().unwrap_or_default().to_string();
                    let response = match command_type.as_str() {
                        "list_agent_peers" => response_success(
                            Some(&id),
                            "list_agent_peers",
                            Some(json!({ "peers": roster["sessions"] })),
                        ),
                        // The observe controller's roster walk.
                        "list" => response_success(
                            Some(&id),
                            "list",
                            Some(json!({ "sessions": roster["sessions"] })),
                        ),
                        // Target-specific transcripts let resolver regressions prove
                        // which worker was read; older fixtures retain their five-row tail.
                        // Serves the tail reads (`start = -limit`) recent messages sends.
                        "get_session_messages" => {
                            let active = command["activeSessionId"].as_str().unwrap_or_default();
                            let messages = roster["messagesByActiveSessionId"]
                                .get(active)
                                .cloned()
                                .unwrap_or_else(|| {
                                    json!([
                                        { "role": "user", "content": "m0", "timestamp": 10 },
                                        { "role": "user", "content": "m1", "timestamp": 11 },
                                        { "role": "user", "content": "m2", "timestamp": 12 },
                                        { "role": "user", "content": "m3", "timestamp": 13 },
                                        { "role": "compactionSummary", "summary": "m4", "timestamp": 14 },
                                    ])
                                });
                            let messages = messages.as_array().unwrap();
                            let tail = usize::try_from(command["limit"].as_u64().unwrap()).unwrap();
                            let begin = messages.len().saturating_sub(tail);
                            let rows: Vec<Value> = messages[begin..]
                                .iter()
                                .enumerate()
                                .map(|(offset, message)| {
                                    json!({ "index": begin + offset, "id": "", "message": message })
                                })
                                .collect();
                            response_success(
                                Some(&id),
                                "get_session_messages",
                                Some(json!({ "messages": rows, "total": messages.len() })),
                            )
                        }
                        "get_worker_peer_transport" => match ticket_response.clone() {
                            Some(ticket) => {
                                response_success(Some(&id), &command_type, Some(ticket))
                            }
                            None => response_failure(
                                Some(&id),
                                &command_type,
                                "Session worker does not support direct peer transport",
                                None,
                            ),
                        },
                        "send_message" => response_success(
                            Some(&id),
                            "send_message",
                            Some(json!({
                                "id": "agentmsg_direct",
                                "source": "agent_message",
                                "target": {
                                    "activeSessionId": "bbb222",
                                    "sessionId": "sess-b",
                                    "runtimeKind": "top-level",
                                },
                                "message": command["message"].clone(),
                                "deliveryStatus": "delivered",
                                "deliveredAt": "2026-01-01T00:00:00.000Z",
                                "deliveryMode": "steer",
                            })),
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

fn controller(
    socket: std::path::PathBuf,
    own_summary: Option<Value>,
) -> LinkAgentMessageController {
    LinkAgentMessageController {
        link: Arc::new(SupervisorLink::new(socket)),
        active_session_id: "aaa111".to_string(),
        worker_token: "tok-a".to_string(),
        own_summary: Arc::new(std::sync::Mutex::new(own_summary)),
        children: None,
    }
}

/// A controller whose children registry holds one resident child: the same
/// registry shape `rlm.list_subagents` reads.
fn controller_with_children(
    socket: std::path::PathBuf,
    own_summary: Option<Value>,
) -> LinkAgentMessageController {
    let children = crate::rlm_children::SupervisorChildSessions::new(
        Arc::new(SupervisorLink::new(socket.clone())),
        std::path::PathBuf::from("/agent"),
        "aaa111".to_string(),
        std::sync::Arc::new(crate::model_allowlist::ModelRefusalTelemetry::new(
            std::path::PathBuf::from("/agent"),
            /*telemetry_disabled*/ true,
        )),
        String::new(),
    );
    let mut controller = controller(socket, own_summary);
    controller.children = Some(Arc::new(children));
    controller
}

/// The observe controller over the same scripted supervisor: roster
/// reads and transcript reads share one link.
fn observe_controller(socket: std::path::PathBuf) -> LinkAgentObserveController {
    LinkAgentObserveController::new(
        Arc::new(SupervisorLink::new(socket)),
        "aaa111".to_string(),
        Arc::new(std::sync::Mutex::new(own_summary())),
        None,
    )
}

/// Seed the children registry with one admitted child (the same state
/// `rlm.spawn` leaves behind, without the supervisor round trip).
async fn admit_child(controller: &LinkAgentMessageController, child: RlmChildIdentity) {
    controller
        .children
        .as_ref()
        .expect("children registry")
        .push_test_child(child)
        .await;
}

fn own_summary() -> Option<Value> {
    Some(json!({
        "activeSessionId": "aaa111",
        "sessionId": "sess-a",
        "sessionName": "alpha",
        "runtimeKind": "top-level",
    }))
}

/// The observe roster reduced to what the family classifiers decide:
/// each listed row's live id and relationship, in roster order.
fn labeled(
    sessions: Vec<Value>,
    identity: &FamilyIdentity,
) -> Vec<(Option<String>, Option<AgentFamilyRelationship>)> {
    summaries_from_roster(sessions, identity, &[])
        .into_iter()
        .map(|summary| (summary.active_session_id, summary.relationship))
        .collect()
}

fn input() -> AgentMessageSendInput {
    AgentMessageSendInput {
        target: "bbb222".to_string(),
        message: "hello there".to_string(),
        receiver_role: Some(AgentFamilyRelationship::Sibling),
    }
}

#[tokio::test]
async fn family_reads_siblings_from_the_supervisor_roster() {
    let dir = tempfile::TempDir::new().unwrap();
    let socket = dir.path().join("sup.sock");
    spawn_fake_supervisor(
        socket.clone(),
        json!({ "sessions": [
            { "activeSessionId": "aaa111", "sessionId": "sess-a", "sessionName": "alpha" },
            { "activeSessionId": "bbb222", "sessionId": "sess-b", "sessionName": "beta" },
            { "activeSessionId": "ccc333", "sessionId": "sess-c" },
        ]}),
        None,
    )
    .await;
    let controller = controller(socket, None);
    let family = controller.family().await.unwrap();
    assert_eq!(family.len(), 2, "{family:?}");
    assert_eq!(family[0].relationship, AgentFamilyRelationship::Sibling);
    assert_eq!(family[0].id, "bbb222");
    assert_eq!(family[0].name.as_deref(), Some("beta"));
    assert_eq!(family[1].id, "ccc333");
    assert_eq!(family[1].name, None);
}

#[tokio::test]
async fn family_labels_children_and_parent_from_the_registry() {
    let dir = tempfile::TempDir::new().unwrap();
    let socket = dir.path().join("sup.sock");
    spawn_fake_supervisor(
        socket.clone(),
        json!({ "sessions": [
            { "activeSessionId": "aaa111", "sessionId": "sess-a", "sessionName": "alpha" },
            { "activeSessionId": "bbb222", "sessionId": "sess-b", "sessionName": "beta",
              "parentActiveSessionId": "ppp000", "parentSessionId": "sess-p",
              "runtimeKind": "subagent" },
            { "activeSessionId": "ddd444", "sessionId": "sess-d", "sessionName": "worker-a" },
            { "activeSessionId": "ppp000", "sessionId": "sess-p", "sessionName": "papa" },
            { "activeSessionId": "xxx999", "sessionId": "sess-x", "sessionName": "beta",
              "runtimeKind": "top-level" },
        ]}),
        None,
    )
    .await;
    let own_summary = Some(json!({
        "activeSessionId": "aaa111",
        "sessionId": "sess-a",
        "sessionName": "alpha",
        "parentActiveSessionId": "ppp000",
        "parentSessionId": "sess-p",
    }));
    let controller = controller_with_children(socket, own_summary);
    admit_child(
        &controller,
        RlmChildIdentity {
            rlm_child_id: "sub-kid1".to_string(),
            active_session_id: "ddd444".to_string(),
            session_id: Some("sess-d".to_string()),
            session_name: "worker-a".to_string(),
        },
    )
    .await;
    let family = controller.family().await.unwrap();
    // TS `selectAgentFamily` order: parent, siblings, children.
    assert_eq!(family.len(), 3, "{family:?}");
    assert_eq!(family[0].relationship, AgentFamilyRelationship::Parent);
    assert_eq!(family[0].id, "ppp000");
    assert_eq!(family[0].name.as_deref(), Some("papa"));
    assert_eq!(family[1].relationship, AgentFamilyRelationship::Sibling);
    assert_eq!(family[1].id, "bbb222");
    assert_eq!(
        family[2].relationship,
        AgentFamilyRelationship::Child,
        "{family:?}"
    );
    assert_eq!(family[2].id, "ddd444");
    assert_eq!(family[2].name.as_deref(), Some("worker-a"));
    assert_eq!(family[2].aliases, vec!["sub-kid1", "sess-d"]);
    assert!(!family
        .iter()
        .any(|member| member.id == "ddd444"
            && member.relationship == AgentFamilyRelationship::Sibling));
    assert!(!family.iter().any(|member| member.id == "xxx999"));
}

#[tokio::test]
async fn family_resolves_the_parent_by_session_id() {
    let dir = tempfile::TempDir::new().unwrap();
    let socket = dir.path().join("sup.sock");
    spawn_fake_supervisor(
        socket.clone(),
        json!({ "sessions": [
            { "activeSessionId": "aaa111", "sessionId": "sess-a" },
            { "activeSessionId": "rrr777", "sessionId": "sess-p", "sessionName": "papa" },
        ]}),
        None,
    )
    .await;
    let own_summary = Some(json!({
        "activeSessionId": "aaa111",
        "sessionId": "sess-a",
        "parentActiveSessionId": "stale-parent",
        "parentSessionId": "sess-p",
    }));
    let controller = controller(socket, own_summary);
    let family = controller.family().await.unwrap();
    assert_eq!(family.len(), 1, "{family:?}");
    assert_eq!(family[0].relationship, AgentFamilyRelationship::Parent);
    assert_eq!(family[0].id, "rrr777");
}

/// Registry children the roster does not list stay addressable as Child
/// members keyed by their durable session id (the wake-resolvable
/// selector), the spawn-time live id kept as an alias.
#[tokio::test]
async fn family_keeps_off_roster_children_addressable() {
    let dir = tempfile::TempDir::new().unwrap();
    let socket = dir.path().join("sup.sock");
    spawn_fake_supervisor(
        socket.clone(),
        json!({ "sessions": [
            { "activeSessionId": "aaa111", "sessionId": "sess-a" },
        ]}),
        None,
    )
    .await;
    let controller = controller_with_children(socket, None);
    admit_child(
        &controller,
        RlmChildIdentity {
            rlm_child_id: "sub-kid2".to_string(),
            active_session_id: "eee555".to_string(),
            session_id: Some("sess-e".to_string()),
            session_name: "worker-b".to_string(),
        },
    )
    .await;
    let family = controller.family().await.unwrap();
    assert_eq!(family.len(), 1, "{family:?}");
    assert_eq!(family[0].relationship, AgentFamilyRelationship::Child);
    assert_eq!(family[0].id, "sess-e");
    assert_eq!(family[0].name.as_deref(), Some("worker-b"));
    assert_eq!(family[0].aliases, vec!["sub-kid2", "sess-e", "eee555"]);
}

#[tokio::test]
async fn refused_ticket_falls_back_to_the_supervisor_route() {
    let dir = tempfile::TempDir::new().unwrap();
    let socket = dir.path().join("sup.sock");
    spawn_fake_supervisor(socket.clone(), json!({ "sessions": [] }), None).await;
    let controller = controller(socket, own_summary());
    let receipt = controller.send_agent_message(input()).await.unwrap();
    assert_eq!(receipt.id, "agentmsg_direct");
    assert_eq!(receipt.target, "bbb222");
    assert_eq!(receipt.target_session_id.as_deref(), Some("sess-b"));
    assert_eq!(
        receipt.delivery_status,
        AgentMessageDeliveryStatus::Delivered
    );
    assert_eq!(receipt.message, "hello there");
    assert_eq!(
        receipt.receiver_role,
        Some(AgentFamilyRelationship::Sibling)
    );
}

#[tokio::test]
async fn self_target_is_refused() {
    let controller = controller(std::path::PathBuf::from("/nonexistent.sock"), None);
    let error = controller
        .send_agent_message(AgentMessageSendInput {
            target: "aaa111".to_string(),
            message: "note to self".to_string(),
            receiver_role: None,
        })
        .await
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "Agent messaging cannot target the sending session"
    );
}

/// A minted ticket delivers straight to the target worker's socket,
/// addressed to the ticket's resolved session: `peer_auth` with the
/// worker purpose, then `worker_deliver_message` carrying the TS
/// sender identity block, and the receipt maps onto the kernel shape.
#[tokio::test]
async fn direct_ticket_delivers_to_the_target_worker_socket() {
    let dir = tempfile::TempDir::new().unwrap();
    let worker_socket = dir.path().join("worker.sock");
    let listener = bind_transport(&worker_socket).await.unwrap();
    let received = Arc::new(std::sync::Mutex::new(Vec::<(String, Value)>::new()));
    let recorded = Arc::clone(&received);
    tokio::spawn(async move {
        let stream = listener.accept().await.unwrap();
        let (reader, mut writer) = stream.split();
        let mut reader = crate::framing::PrivateFrameReader::new(
            reader,
            crate::framing::DEFAULT_PRIVATE_FRAME_LIMITS,
        );
        let hello = crate::framing::encode_private_frame(
            &json!({ "kind": "outbound", "outboundType": "daemon_hello" }),
            b"{}".as_slice(),
            crate::framing::DEFAULT_PRIVATE_FRAME_LIMITS,
        )
        .unwrap();
        writer.write_all(&hello).await.unwrap();
        loop {
            let Some(frame) = reader.read_frame().await.unwrap() else {
                return;
            };
            let command_type = frame
                .header
                .get("commandType")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let request_id = frame
                .header
                .get("requestId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let payload: Value = serde_json::from_slice(&frame.payload).unwrap();
            recorded
                .lock()
                .unwrap()
                .push((command_type.clone(), payload.clone()));
            let response = match command_type.as_str() {
                "peer_auth" => response_success(
                    Some(&request_id),
                    "peer_auth",
                    Some(json!({
                        "workerInstanceId": "inst-b",
                        "activeSessionId": "bbb222",
                        "purpose": "worker",
                    })),
                ),
                "worker_deliver_message" => response_success(
                    Some(&request_id),
                    "worker_deliver_message",
                    Some(json!({
                        "id": "agentmsg_peer",
                        "source": "agent_message",
                        "target": {
                            "activeSessionId": "bbb222",
                            "sessionId": "sess-b",
                            "sessionName": "beta",
                            "runtimeKind": "top-level",
                        },
                        "message": payload["message"].clone(),
                        "deliveryStatus": "queued",
                        "queuedAt": "2026-01-01T00:00:00.000Z",
                        "deliveryMode": "steer",
                    })),
                ),
                other => response_failure(Some(&request_id), other, "unexpected", None),
            };
            let frame = crate::framing::encode_private_frame(
                &json!({
                    "kind": "outbound",
                    "requestId": request_id,
                    "outboundType": "response",
                }),
                &serde_json::to_vec(&response).unwrap(),
                crate::framing::DEFAULT_PRIVATE_FRAME_LIMITS,
            )
            .unwrap();
            writer.write_all(&frame).await.unwrap();
        }
    });

    let ticket = json!({
        "purpose": "worker",
        "socketPath": worker_socket.to_string_lossy(),
        "socketIdentity": { "dev": 1, "ino": 1 },
        "workerInstanceId": "inst-b",
        "activeSessionId": "bbb222",
        "grantId": "g1",
        "token": "secret",
        "expiresAt": "2026-01-01T00:00:30.000Z",
    });
    let socket = dir.path().join("sup.sock");
    spawn_fake_supervisor(socket.clone(), json!({ "sessions": [] }), Some(ticket)).await;
    let controller = controller(socket, own_summary());
    // The supervisor resolved the durable selector "sess-b" into the ticket.
    let receipt = controller
        .send_agent_message(AgentMessageSendInput {
            target: "sess-b".to_string(),
            ..input()
        })
        .await
        .unwrap();
    assert_eq!(receipt.id, "agentmsg_peer");
    assert_eq!(receipt.delivery_status, AgentMessageDeliveryStatus::Queued);
    assert_eq!(receipt.target, "bbb222");
    assert_eq!(receipt.target_session_name.as_deref(), Some("beta"));

    // The wire saw the exact two commands with the TS shapes.
    let received = received.lock().unwrap().clone();
    assert_eq!(received.len(), 2, "{received:?}");
    assert_eq!(received[0].0, "peer_auth");
    assert_eq!(received[0].1["purpose"], "worker");
    assert_eq!(received[0].1["grantId"], "g1");
    assert_eq!(received[1].0, "worker_deliver_message");
    let delivery = &received[1].1;
    assert_eq!(delivery["targetActiveSessionId"], "bbb222");
    assert_eq!(delivery["message"], "hello there");
    // TS sender identity block: endpoint fields plus the agent client id.
    assert_eq!(delivery["sender"]["activeSessionId"], "aaa111");
    assert_eq!(delivery["sender"]["sessionId"], "sess-a");
    assert_eq!(delivery["sender"]["sessionName"], "alpha");
    assert_eq!(delivery["sender"]["runtimeKind"], "top-level");
    assert_eq!(delivery["sender"]["clientId"], "agent");
}

#[test]
fn same_session_file_resolves_the_storage_root_alias() {
    assert!(same_session_file(
        "/agent/sessions/01a0d0a5-e954-71b7-8479-8dc7980768a1.jsonl",
        "/agent/sessions/01a0d0a5-e954-71b7-8479-8dc7980768a1.jsonl",
    ));
    assert!(same_session_file(
        "/old-agent-root/sessions/01a0d0a5-e954-71b7-8479-8dc7980768a1.jsonl",
        "/agent/session-artifacts/sess-p/sub-1/01a0d0a5-e954-71b7-8479-8dc7980768a1.jsonl",
    ));
    assert!(!same_session_file(
        "/agent/sessions/01a0d0a5-e954-71b7-8479-8dc7980768a1.jsonl",
        "/agent/sessions/21b1e1b6-f065-4288-9fa0-9ec8980768a2.jsonl",
    ));
    // The durable id is uuid-shaped: a shared NON-uuid stem (arbitrary
    // create-provided sessionPath values) never aliases across families.
    assert!(!same_session_file(
        "/project-a/session.jsonl",
        "/project-b/session.jsonl",
    ));
}

#[test]
fn summaries_label_the_nuclear_family_by_durable_edges() {
    let identity = FamilyIdentity {
        active_session_id: "kid111".to_string(),
        session_id: Some("sess-kid".to_string()),
        session_file: Some("/agent/session-artifacts/sess-p/sub-2/sess-kid.jsonl".to_string()),
        parent_active_session_id: Some("ppp000".to_string()),
        parent_session_id: Some("sess-p".to_string()),
        parent_session_path: Some("/agent/sessions/sess-p.jsonl".to_string()),
        rlm_depth: 1,
    };
    let sessions = vec![
        json!({
            "activeSessionId": "kid111", "sessionId": "sess-kid",
            "sessionName": "self", "runtimeKind": "subagent", "activity": "idle",
        }),
        json!({
            "activeSessionId": "ppp000", "sessionId": "sess-p",
            "sessionName": "papa", "runtimeKind": "top-level", "activity": "idle",
        }),
        json!({
            "activeSessionId": "sib222", "sessionId": "sess-sib",
            "sessionName": "sibling", "runtimeKind": "subagent", "activity": "working",
            "parentActiveSessionId": "ppp000", "parentSessionId": "sess-p",
        }),
        json!({
            "activeSessionId": "own333", "sessionId": "sess-own",
            "sessionName": "own-child", "runtimeKind": "subagent", "activity": "idle",
            "parentActiveSessionId": "kid111", "parentSessionId": "sess-kid",
        }),
        json!({
            "activeSessionId": "foreign444", "sessionId": "sess-foreign",
            "sessionName": "survey-stream-route", "runtimeKind": "subagent",
            "parentActiveSessionId": "other999", "parentSessionId": "sess-other",
        }),
        json!({
            "activeSessionId": "root555", "sessionId": "sess-root",
            "sessionName": "another-root", "runtimeKind": "top-level",
        }),
    ];
    let summaries = summaries_from_roster(sessions, &identity, &[]);
    assert_eq!(summaries.len(), 4, "{summaries:?}");
    let current = summaries.iter().find(|s| s.is_current).unwrap();
    assert_eq!(current.active_session_id.as_deref(), Some("kid111"));
    assert_eq!(current.relationship, None);
    let parent = summaries
        .iter()
        .find(|s| s.active_session_id.as_deref() == Some("ppp000"))
        .unwrap();
    assert_eq!(parent.relationship, Some(AgentFamilyRelationship::Parent));
    let sibling = summaries
        .iter()
        .find(|s| s.active_session_id.as_deref() == Some("sib222"))
        .unwrap();
    assert_eq!(sibling.relationship, Some(AgentFamilyRelationship::Sibling));
    let child = summaries
        .iter()
        .find(|s| s.active_session_id.as_deref() == Some("own333"))
        .unwrap();
    assert_eq!(child.relationship, Some(AgentFamilyRelationship::Child));
    assert!(!summaries
        .iter()
        .any(|s| s.active_session_id.as_deref() == Some("foreign444")));
    assert!(!summaries
        .iter()
        .any(|s| s.active_session_id.as_deref() == Some("root555")));
}

#[test]
fn summaries_bind_a_child_one_level_down_and_leave_a_same_depth_fork_out() {
    let parent = FamilyIdentity {
        active_session_id: "ppp000".to_string(),
        session_id: Some("sess-p".to_string()),
        session_file: Some("/agent/sessions/sess-p.jsonl".to_string()),
        parent_session_path: Some("/agent/sessions/sess-r.jsonl".to_string()),
        rlm_depth: 1,
        ..Default::default()
    };
    let sessions = vec![
        json!({
            "activeSessionId": "ppp000", "sessionId": "sess-p",
            "runtimeKind": "top-level", "activity": "idle",
            "parentSessionPath": "/agent/sessions/sess-r.jsonl", "rlmDepth": 1,
        }),
        json!({
            "activeSessionId": "usr111", "sessionId": "sess-usr",
            "runtimeKind": "top-level", "activity": "working",
            "parentSessionPath": "/agent/sessions/sess-p.jsonl", "rlmDepth": 2,
        }),
        json!({
            "activeSessionId": "frk222", "sessionId": "sess-frk",
            "runtimeKind": "top-level", "activity": "working",
            "parentSessionPath": "/agent/sessions/sess-p.jsonl", "rlmDepth": 1,
        }),
    ];
    assert_eq!(
        labeled(sessions, &parent),
        vec![
            (Some("ppp000".to_string()), None),
            (
                Some("usr111".to_string()),
                Some(AgentFamilyRelationship::Child)
            ),
        ]
    );

    // From the user child's own view: a same-depth subagent of the same
    // parent is a Sibling; the fork one level up is outside the family.
    let user_child = FamilyIdentity {
        active_session_id: "usr111".to_string(),
        session_id: Some("sess-usr".to_string()),
        session_file: Some("/agent/sessions/sess-usr.jsonl".to_string()),
        parent_session_path: Some("/agent/sessions/sess-p.jsonl".to_string()),
        rlm_depth: 2,
        ..Default::default()
    };
    let sessions = vec![
        json!({
            "activeSessionId": "usr111", "sessionId": "sess-usr",
            "runtimeKind": "top-level", "activity": "working",
            "parentSessionPath": "/agent/sessions/sess-p.jsonl", "rlmDepth": 2,
        }),
        json!({
            "activeSessionId": "sub333", "sessionId": "sess-sub",
            "runtimeKind": "subagent", "activity": "idle",
            "parentSessionPath": "/agent/sessions/sess-p.jsonl", "rlmDepth": 2,
        }),
        json!({
            "activeSessionId": "frk222", "sessionId": "sess-frk",
            "runtimeKind": "top-level", "activity": "working",
            "parentSessionPath": "/agent/sessions/sess-p.jsonl", "rlmDepth": 1,
        }),
    ];
    assert_eq!(
        labeled(sessions, &user_child),
        vec![
            (Some("usr111".to_string()), None),
            (
                Some("sub333".to_string()),
                Some(AgentFamilyRelationship::Sibling)
            ),
        ]
    );
}

#[test]
fn summaries_treat_a_root_fork_as_a_root() {
    let parent = FamilyIdentity {
        active_session_id: "ppp000".to_string(),
        session_id: Some("sess-p".to_string()),
        session_file: Some("/agent/sessions/sess-p.jsonl".to_string()),
        ..Default::default()
    };
    let sessions = vec![
        json!({
            "activeSessionId": "ppp000", "sessionId": "sess-p",
            "sessionName": "papa", "runtimeKind": "top-level", "activity": "idle",
        }),
        json!({
            "activeSessionId": "usr111", "sessionId": "sess-usr",
            "sessionName": "user-child", "runtimeKind": "top-level",
            "activity": "working",
            "parentSessionPath": "/agent/sessions/sess-p.jsonl", "rlmDepth": 1,
        }),
        json!({
            "activeSessionId": "frk222", "sessionId": "sess-frk",
            "sessionName": "fork", "runtimeKind": "top-level",
            "activity": "working",
            "parentSessionPath": "/agent/sessions/sess-p.jsonl", "rlmDepth": 0,
        }),
    ];
    assert_eq!(
        labeled(sessions, &parent),
        vec![
            (Some("ppp000".to_string()), None),
            (
                Some("usr111".to_string()),
                Some(AgentFamilyRelationship::Child)
            ),
            (
                Some("frk222".to_string()),
                Some(AgentFamilyRelationship::Sibling)
            ),
        ]
    );

    // From the root fork's own view: its source and every other root are
    // Siblings, never a Parent.
    let fork = FamilyIdentity::from_summary(
        Some(&json!({
            "sessionId": "sess-frk",
            "sessionFile": "/agent/sessions/sess-frk.jsonl",
            "parentSessionPath": "/agent/sessions/sess-p.jsonl",
            "rlmDepth": 0,
        })),
        "frk222",
    );
    let sessions = vec![
        json!({
            "activeSessionId": "frk222", "sessionId": "sess-frk",
            "runtimeKind": "top-level", "activity": "idle",
            "parentSessionPath": "/agent/sessions/sess-p.jsonl", "rlmDepth": 0,
        }),
        json!({
            "activeSessionId": "ppp000", "sessionId": "sess-p",
            "sessionName": "papa", "runtimeKind": "top-level", "activity": "idle",
            "sessionFile": "/agent/sessions/sess-p.jsonl", "rlmDepth": 0,
        }),
        json!({
            "activeSessionId": "oth444", "sessionId": "sess-oth",
            "runtimeKind": "top-level", "activity": "idle", "rlmDepth": 0,
        }),
    ];
    assert_eq!(
        labeled(sessions, &fork),
        vec![
            (Some("frk222".to_string()), None),
            (
                Some("ppp000".to_string()),
                Some(AgentFamilyRelationship::Sibling)
            ),
            (
                Some("oth444".to_string()),
                Some(AgentFamilyRelationship::Sibling)
            ),
        ]
    );
}

/// TS #2493: observe rows carry the typed family status (the busy verdict) plus the
/// separate live activity axis — a quiet row is `idle`, never the pre-fix `inactive`.
#[test]
fn summaries_carry_the_typed_status_and_activity() {
    let identity = FamilyIdentity {
        active_session_id: "me000".to_string(),
        session_id: Some("sess-me".to_string()),
        session_file: Some("/agent/sessions/sess-me.jsonl".to_string()),
        parent_active_session_id: Some("ppp00".to_string()),
        parent_session_id: Some("sess-p".to_string()),
        parent_session_path: Some("/agent/sessions/sess-p.jsonl".to_string()),
        rlm_depth: 1,
    };
    let sessions = vec![
        // The current session streams a tool call: running, tool work.
        json!({
            "activeSessionId": "me000", "sessionId": "sess-me", "runtimeKind": "top-level",
            "activity": "working", "isStreaming": true, "isCompacting": false,
            "isSessionActive": true, "isRunningTools": true, "attachedClients": 1,
        }),
        // The parent sits quiet with a client attached: idle, a user.
        json!({
            "activeSessionId": "ppp00", "sessionId": "sess-p", "runtimeKind": "top-level",
            "activity": "idle", "isStreaming": false, "isCompacting": false,
            "isSessionActive": false, "isRunningTools": false, "attachedClients": 1,
        }),
        // A child mid-compaction: running, compacting.
        json!({
            "activeSessionId": "ch111", "sessionId": "sess-ch", "runtimeKind": "subagent",
            "activity": "working", "isStreaming": false, "isCompacting": true,
            "isSessionActive": true, "isRunningTools": false, "attachedClients": 0,
            "parentActiveSessionId": "me000", "parentSessionId": "sess-me",
        }),
        // A quiet child with no client: idle, idle.
        json!({
            "activeSessionId": "ch222", "sessionId": "sess-ch2", "runtimeKind": "subagent",
            "activity": "idle", "isStreaming": false, "isCompacting": false,
            "isSessionActive": false, "isRunningTools": false, "attachedClients": 0,
            "parentActiveSessionId": "me000", "parentSessionId": "sess-me",
        }),
        // A passivated ledger child: an INACTIVE family member, never a
        // live quiet session, and no activity axis.
        json!({
            "id": "ch333", "sessionId": "sess-ch3", "runtimeKind": "subagent",
            "activity": "idle", "isStreaming": false, "isCompacting": false,
            "isSessionActive": false, "isRunningTools": false, "attachedClients": 0,
            "parentActiveSessionId": "me000", "parentSessionId": "sess-me",
        }),
    ];
    let summaries = summaries_from_roster(sessions, &identity, &[]);
    assert_eq!(summaries.len(), 5, "{summaries:?}");
    let row = |id: &str| {
        summaries
            .iter()
            .find(|s| s.active_session_id.as_deref() == Some(id))
            .unwrap_or_else(|| panic!("missing row {id}: {summaries:?}"))
    };
    assert_eq!(row("me000").status, AgentFamilyStatus::Running);
    assert_eq!(row("me000").activity, Some(AgentObserveActivity::Tool));
    assert_eq!(row("ppp00").status, AgentFamilyStatus::Idle);
    assert_eq!(row("ppp00").activity, Some(AgentObserveActivity::User));
    assert_eq!(row("ch111").status, AgentFamilyStatus::Running);
    assert_eq!(
        row("ch111").activity,
        Some(AgentObserveActivity::Compacting)
    );
    assert_eq!(row("ch222").status, AgentFamilyStatus::Idle);
    assert_eq!(row("ch222").activity, Some(AgentObserveActivity::Idle));
    let passivated = summaries
        .iter()
        .find(|s| s.session_id == "sess-ch3")
        .expect("the passivated child stays an addressable family row");
    assert_eq!(passivated.status, AgentFamilyStatus::Inactive);
    assert_eq!(passivated.activity, None);
}

#[test]
fn summaries_label_root_siblings_and_never_foreign_children() {
    let identity = FamilyIdentity {
        active_session_id: "root111".to_string(),
        session_id: Some("sess-root".to_string()),
        session_file: Some("/agent/sessions/sess-root.jsonl".to_string()),
        ..Default::default()
    };
    let sessions = vec![
        json!({
            "activeSessionId": "root111", "sessionId": "sess-root",
            "runtimeKind": "top-level", "activity": "idle",
        }),
        json!({
            "activeSessionId": "root222", "sessionId": "sess-root2",
            "runtimeKind": "top-level", "activity": "idle",
        }),
        json!({
            "activeSessionId": "child999", "sessionId": "sess-child",
            "runtimeKind": "subagent", "parentActiveSessionId": "root222",
        }),
    ];
    let summaries = summaries_from_roster(sessions, &identity, &[]);
    assert_eq!(summaries.len(), 2, "{summaries:?}");
    assert!(summaries.iter().any(|s| s.is_current));
    let sibling = summaries
        .iter()
        .find(|s| s.active_session_id.as_deref() == Some("root222"))
        .unwrap();
    assert_eq!(sibling.relationship, Some(AgentFamilyRelationship::Sibling));
    assert!(!summaries
        .iter()
        .any(|s| s.active_session_id.as_deref() == Some("child999")));
}

#[tokio::test]
async fn family_resolves_a_moved_parent_by_the_peers_roster_alias() {
    let dir = tempfile::TempDir::new().unwrap();
    let socket = dir.path().join("sup.sock");
    spawn_fake_supervisor(
        socket.clone(),
        json!({ "sessions": [
            { "activeSessionId": "aaa111", "sessionId": "sess-a" },
            { "activeSessionId": "rrr777", "sessionId": "sess-p", "sessionName": "papa",
              "sessionPath": "/agent/session-artifacts/sess-g/sub-9/01a0d0a5-e954-71b7-8479-8dc7980768a1.jsonl" },
        ]}),
        None,
    )
    .await;
    let own_summary = Some(json!({
        "activeSessionId": "aaa111",
        "sessionId": "sess-a",
        "parentActiveSessionId": "stale-parent",
        "parentSessionPath": "/old-agent-root/sessions/01a0d0a5-e954-71b7-8479-8dc7980768a1.jsonl",
        "rlmDepth": 1,
    }));
    let controller = controller(socket, own_summary);
    let family = controller.family().await.unwrap();
    assert_eq!(family.len(), 1, "{family:?}");
    assert_eq!(family[0].relationship, AgentFamilyRelationship::Parent);
    assert_eq!(family[0].id, "rrr777");
}

#[tokio::test]
async fn family_joins_a_replaced_child_by_its_durable_ids() {
    let dir = tempfile::TempDir::new().unwrap();
    let socket = dir.path().join("sup.sock");
    spawn_fake_supervisor(
        socket.clone(),
        json!({ "sessions": [
            { "activeSessionId": "aaa111", "sessionId": "sess-a" },
            { "activeSessionId": "new999", "sessionId": "sess-kid",
              "sessionName": "kid", "rlmChildId": "sub-kid1",
              "parentActiveSessionId": "aaa111", "parentSessionId": "sess-a" },
        ]}),
        None,
    )
    .await;
    let controller = controller_with_children(socket, own_summary());
    admit_child(
        &controller,
        RlmChildIdentity {
            rlm_child_id: "sub-kid1".to_string(),
            active_session_id: "ddd444".to_string(),
            session_id: Some("sess-kid".to_string()),
            session_name: "kid".to_string(),
        },
    )
    .await;
    let family = controller.family().await.unwrap();
    let children: Vec<_> = family
        .iter()
        .filter(|member| member.relationship == AgentFamilyRelationship::Child)
        .collect();
    assert_eq!(children.len(), 1, "{family:?}");
    assert_eq!(children[0].id, "new999");
    assert!(children[0].aliases.contains(&"sub-kid1".to_string()));
}

#[tokio::test]
async fn family_resolves_a_moved_parent_by_the_session_file_alias() {
    let dir = tempfile::TempDir::new().unwrap();
    let socket = dir.path().join("sup.sock");
    spawn_fake_supervisor(
        socket.clone(),
        json!({ "sessions": [
            { "activeSessionId": "aaa111", "sessionId": "sess-a" },
            { "activeSessionId": "rrr777", "sessionId": "sess-p", "sessionName": "papa",
              "sessionFile": "/agent/session-artifacts/sess-g/sub-9/01a0d0a5-e954-71b7-8479-8dc7980768a1.jsonl" },
        ]}),
        None,
    )
    .await;
    let own_summary = Some(json!({
        "activeSessionId": "aaa111",
        "sessionId": "sess-a",
        "parentActiveSessionId": "stale-parent",
        "parentSessionPath": "/old-agent-root/sessions/01a0d0a5-e954-71b7-8479-8dc7980768a1.jsonl",
        "rlmDepth": 1,
    }));
    let controller = controller(socket, own_summary);
    let family = controller.family().await.unwrap();
    assert_eq!(family.len(), 1, "{family:?}");
    assert_eq!(family[0].relationship, AgentFamilyRelationship::Parent);
    assert_eq!(family[0].id, "rrr777");
}

/// TS `AgentObserveListResult`: the daemon roster walk splits the
/// caller's own row into `current` and keeps the family in `agents`.
#[tokio::test]
async fn list_agents_returns_current_and_family_without_self() {
    let dir = tempfile::TempDir::new().unwrap();
    let socket = dir.path().join("sup.sock");
    spawn_fake_supervisor(
        socket.clone(),
        json!({ "sessions": [
            { "activeSessionId": "aaa111", "sessionId": "sess-a", "sessionName": "alpha",
              "cwd": "/w", "messageCount": 7 },
            { "activeSessionId": "bbb222", "sessionId": "sess-b", "sessionName": "beta" },
            { "activeSessionId": "ddd444", "sessionId": "sess-d", "sessionName": "kid",
              "runtimeKind": "subagent",
              "parentActiveSessionId": "aaa111", "parentSessionId": "sess-a",
              "rlmChildId": "sub-kid1" },
        ]}),
        None,
    )
    .await;
    let observer = observe_controller(socket);
    let list = observer.list_agents().await.unwrap();
    assert_eq!(list.current.active_session_id.as_deref(), Some("aaa111"));
    assert!(list.current.is_current);
    assert_eq!(
        list.agents.len(),
        2,
        "the family roster excludes the caller: {:?}",
        list.agents
    );
    assert!(list.agents.iter().all(|summary| !summary.is_current));
    assert!(
        list.agents
            .iter()
            .any(|summary| summary.active_session_id.as_deref() == Some("bbb222")),
        "the sibling stays in the roster"
    );
    let child = list
        .agents
        .iter()
        .find(|summary| summary.active_session_id.as_deref() == Some("ddd444"))
        .expect("the child stays in the roster");
    assert_eq!(child.relationship, Some(AgentFamilyRelationship::Child));
}

/// TS `AgentObserveRecentMessagesResult`: the transcript read resolves
/// the family target first (the family gate), then reports the bounded
/// window with its clamped bounds.
#[tokio::test]
async fn recent_messages_resolves_by_name_and_reports_the_envelope() {
    let dir = tempfile::TempDir::new().unwrap();
    let socket = dir.path().join("sup.sock");
    spawn_fake_supervisor(
        socket.clone(),
        json!({ "sessions": [
            { "activeSessionId": "aaa111", "sessionId": "sess-a", "sessionName": "alpha" },
            { "activeSessionId": "ddd444", "sessionId": "sess-d", "sessionName": "kid",
              "runtimeKind": "subagent",
              "parentActiveSessionId": "aaa111", "parentSessionId": "sess-a" },
        ]}),
        None,
    )
    .await;
    let observer = observe_controller(socket);
    let recent = observer.recent_messages("kid", 2, 90).await.unwrap();
    assert_eq!(recent.agent.active_session_id.as_deref(), Some("ddd444"));
    assert_eq!(recent.limit, 2);
    assert_eq!(recent.max_chars, 90);
    assert!(
        recent.truncated,
        "five scripted rows minus two leave older ones"
    );
    assert_eq!(recent.messages.len(), 2);
    assert_eq!(recent.messages[0].index, 3);
    assert_eq!(recent.messages[0].text, "m3");
    assert_eq!(
        recent.messages[1].text, "m4",
        "the compaction summary previews"
    );
    // A target outside the nuclear family never reaches the transcript read.
    let error = observer.recent_messages("ghost", 2, 90).await.unwrap_err();
    assert_eq!(error.to_string(), "agent ghost is not reachable");
}

/// The display reader keeps a custom row's stored ISO timestamp. Its
/// public observe preview must preserve that timestamp as epoch milliseconds.
#[tokio::test]
async fn recent_messages_preserves_custom_transcript_timestamps() {
    let mut store = crate::session_store::SessionFile::create("/fixture", None, 0);
    store.append_message(&json!({"role": "user", "content": "hello", "timestamp": 13}));
    store.append_entry(
        "custom_message",
        json!({
            "customType": "agent_message", "content": "notice", "display": true,
        }),
    );
    store.entries.last_mut().unwrap().timestamp = "2004-07-21T00:47:44.465Z".to_string();
    let transcript = store
        .session_messages(-10, 10, |_| true, &std::collections::HashSet::new())
        .unwrap()
        .into_reply();
    let messages: Vec<Value> = transcript["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["message"].clone())
        .collect();
    let dir = tempfile::TempDir::new().unwrap();
    let socket = dir.path().join("sup.sock");
    spawn_fake_supervisor(socket.clone(), json!({
        "sessions": [
            {"activeSessionId": "aaa111", "sessionId": "sess-a"},
            {"activeSessionId": "ddd444", "sessionId": "sess-d", "sessionName": "kid",
             "runtimeKind": "subagent", "parentActiveSessionId": "aaa111", "parentSessionId": "sess-a"},
        ],
        "messagesByActiveSessionId": {"ddd444": messages},
    }), None).await;
    let recent = observe_controller(socket)
        .recent_messages("kid", 10, 90)
        .await
        .unwrap();
    assert_eq!(
        recent.messages,
        vec![
            AgentObserveMessagePreview {
                index: 0,
                role: "user".into(),
                timestamp: Some(13),
                text: "hello".into(),
                truncated: false,
                tool_calls: Vec::new(),
                custom_type: None,
            },
            AgentObserveMessagePreview {
                index: 1,
                role: "custom".into(),
                timestamp: Some(1_090_370_864_465),
                text: "notice".into(),
                truncated: false,
                tool_calls: Vec::new(),
                custom_type: Some("agent_message".into()),
            },
        ]
    );
}

#[tokio::test]
async fn recent_messages_reads_a_degraded_live_sibling_but_not_a_foreign_stub() {
    let dir = tempfile::TempDir::new().unwrap();
    let socket = dir.path().join("sup.sock");
    spawn_fake_supervisor(
        socket.clone(),
        json!({ "sessions": [
            { "activeSessionId": "aaa111", "sessionId": "sess-a",
              "parentActiveSessionId": "parent", "parentSessionId": "sess-parent" },
            { "id": "sibling", "sessionId": "", "lifecycle": "recovering",
              "parentActiveSessionId": "parent", "parentSessionId": "sess-parent" },
            { "id": "foreign", "sessionId": "", "lifecycle": "recovering" },
        ], "messagesByActiveSessionId": {
            "sibling": [{ "role": "user", "content": "sibling transcript" }],
            "foreign": [{ "role": "user", "content": "foreign transcript" }],
        }}),
        None,
    )
    .await;
    let observer = LinkAgentObserveController::new(
        Arc::new(SupervisorLink::new(socket)),
        "aaa111".to_string(),
        Arc::new(std::sync::Mutex::new(Some(json!({
            "activeSessionId": "aaa111", "sessionId": "sess-a",
            "parentActiveSessionId": "parent", "parentSessionId": "sess-parent",
        })))),
        None,
    );
    let recent = observer.recent_messages("sibling", 8, 800).await.unwrap();
    assert_eq!(
        recent.agent.relationship,
        Some(AgentFamilyRelationship::Sibling)
    );
    assert_eq!(recent.messages.len(), 1);
    assert_eq!(recent.messages[0].text, "sibling transcript");
    assert_eq!(
        observer
            .recent_messages("foreign", 8, 800)
            .await
            .unwrap_err()
            .to_string(),
        "agent foreign is not reachable",
    );
}

/// The supervisor roster row's own facts ride the observation summary,
/// with `firstMessage` capped at the TS preview width.
#[test]
fn summaries_carry_the_supervisor_row_facts() {
    let identity = FamilyIdentity {
        active_session_id: "ppp000".to_string(),
        session_id: Some("sess-p".to_string()),
        session_file: Some("/agent/sessions/sess-p.jsonl".to_string()),
        ..Default::default()
    };
    let sessions = vec![
        json!({
            "activeSessionId": "ppp000", "sessionId": "sess-p",
            "runtimeKind": "top-level", "activity": "idle",
            "cwd": "/w/agent", "messageCount": 12,
        }),
        json!({
            "activeSessionId": "kid111", "sessionId": "sess-kid",
            "sessionName": "kid", "runtimeKind": "subagent", "activity": "working",
            "cwd": "/w/agent/kid", "messageCount": 3,
            "parentActiveSessionId": "ppp000", "parentSessionId": "sess-p",
            "rlmChildId": "sub-kid1", "firstMessage": "x".repeat(300),
        }),
    ];
    let summaries = summaries_from_roster(sessions, &identity, &[]);
    let child = summaries
        .iter()
        .find(|summary| summary.session_id == "sess-kid")
        .expect("the child row");
    assert_eq!(child.cwd.as_deref(), Some("/w/agent/kid"));
    assert_eq!(child.message_count, Some(3));
    assert_eq!(child.parent_active_session_id.as_deref(), Some("ppp000"));
    assert_eq!(child.parent_session_id.as_deref(), Some("sess-p"));
    assert_eq!(child.rlm_child_id.as_deref(), Some("sub-kid1"));
    assert_eq!(
        child.first_message.as_ref().map(String::len),
        Some(240),
        "firstMessage caps at the TS preview width"
    );
    let current = summaries
        .iter()
        .find(|summary| summary.is_current)
        .expect("the caller's own row");
    assert_eq!(current.cwd.as_deref(), Some("/w/agent"));
    assert_eq!(current.message_count, Some(12));
}

/// Normalized active-id and durable-id suffixes still resolve through the
/// nuclear family to the correct worker transcript (the pre-PR registry contract).
#[tokio::test]
async fn observe_recent_suffixes_read_the_selected_family_transcript() {
    let dir = tempfile::TempDir::new().unwrap();
    let socket = dir.path().join("sup.sock");
    spawn_fake_supervisor(socket.clone(), json!({
        "sessions": [
            { "activeSessionId": "aaa111", "sessionId": "sess-a" },
            { "activeSessionId": "abcddd444", "sessionId": "deadbeef-112233",
              "runtimeKind": "subagent", "parentActiveSessionId": "aaa111", "parentSessionId": "sess-a" },
        ],
        "messagesByActiveSessionId": {
            "aaa111": [{ "role": "user", "content": "wrong parent transcript", "timestamp": 1 }],
            "abcddd444": [{ "role": "user", "content": "selected child transcript", "timestamp": 2 }],
        },
    }), None).await;
    let observer = observe_controller(socket);
    for selector in ["DD-D444", "11-2233"] {
        let recent = observer.recent_messages(selector, 1, 80).await.unwrap();
        assert_eq!(recent.agent.active_session_id.as_deref(), Some("abcddd444"));
        assert_eq!(recent.messages[0].text, "selected child transcript");
    }
}

/// Names may repeat across parent/child scopes. An ambiguous family name
/// never authorizes whichever transcript happened to arrive first in the roster.
#[tokio::test]
async fn observe_recent_rejects_duplicate_family_names() {
    let dir = tempfile::TempDir::new().unwrap();
    let socket = dir.path().join("sup.sock");
    spawn_fake_supervisor(socket.clone(), json!({ "sessions": [
        { "activeSessionId": "aaa111", "sessionId": "sess-a", "sessionName": "reviewer" },
        { "activeSessionId": "ddd444", "sessionId": "sess-d", "sessionName": "reviewer",
          "runtimeKind": "subagent", "parentActiveSessionId": "aaa111", "parentSessionId": "sess-a" },
    ]}), None).await;
    let error = observe_controller(socket)
        .recent_messages("reviewer", 1, 80)
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("Ambiguous active session"),
        "{error}"
    );
}

/// The exact active id outranks a different family member named after it,
/// matching the registry's direct lookup before its suffix/name search.
#[tokio::test]
async fn observe_recent_exact_active_id_outranks_a_name_collision() {
    let dir = tempfile::TempDir::new().unwrap();
    let socket = dir.path().join("sup.sock");
    spawn_fake_supervisor(socket.clone(), json!({
        "sessions": [
            { "activeSessionId": "aaa111", "sessionId": "sess-a" },
            { "activeSessionId": "fff555", "sessionId": "sess-f", "sessionName": "ddd444",
              "runtimeKind": "subagent", "parentActiveSessionId": "aaa111", "parentSessionId": "sess-a" },
            { "activeSessionId": "ddd444", "sessionId": "sess-d",
              "runtimeKind": "subagent", "parentActiveSessionId": "aaa111", "parentSessionId": "sess-a" },
        ],
        "messagesByActiveSessionId": {
            "fff555": [{ "role": "user", "content": "wrong name collision", "timestamp": 1 }],
            "ddd444": [{ "role": "user", "content": "exact active transcript", "timestamp": 2 }],
        },
    }), None).await;
    let recent = observe_controller(socket)
        .recent_messages("ddd444", 1, 80)
        .await
        .unwrap();
    assert_eq!(recent.messages[0].text, "exact active transcript");
}

/// Suffix resolution must stay inside the nuclear family; a known foreign
/// worker with a matching suffix never becomes readable.
#[tokio::test]
async fn observe_recent_suffix_does_not_read_a_foreign_transcript() {
    let dir = tempfile::TempDir::new().unwrap();
    let socket = dir.path().join("sup.sock");
    spawn_fake_supervisor(socket.clone(), json!({
        "sessions": [
            { "activeSessionId": "aaa111", "sessionId": "sess-a" },
            { "activeSessionId": "fffddd444", "sessionId": "foreign-id", "sessionName": "foreign",
              "runtimeKind": "subagent", "parentActiveSessionId": "zzz999", "parentSessionId": "foreign-parent" },
        ],
        "messagesByActiveSessionId": {
            "fffddd444": [{ "role": "user", "content": "foreign private transcript", "timestamp": 1 }],
        },
    }), None).await;
    let error = observe_controller(socket)
        .recent_messages("ddd444", 1, 80)
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "agent ddd444 is not reachable");
}
