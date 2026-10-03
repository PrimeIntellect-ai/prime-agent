//! The agent-messaging unit battery: the message validation and prompt
//! shapes, the host-handler round trips, and the observe rows.
use super::*;

/// TS #2493: an observation row carries the typed family status and
/// its live activity (a separate axis), and a member with no live
/// session omits the activity field entirely.
#[test]
fn observe_rows_carry_the_typed_status_and_activity() {
    let mut row = AgentObserveSummary {
        active_session_id: Some("live-1".to_string()),
        session_id: "sess-1".to_string(),
        session_name: Some("worker".to_string()),
        relationship: Some(AgentFamilyRelationship::Child),
        runtime_kind: Some("subagent".to_string()),
        status: AgentFamilyStatus::Running,
        activity: Some(AgentObserveActivity::Tool),
        is_current: false,
        is_streaming: true,
        is_compacting: false,
        attached_clients: 1,
        queued_count: 0,
        is_session_active: true,
    };
    let value = row.to_value();
    assert_eq!(value["status"], "running");
    assert_eq!(value["activity"], "tool");

    row.status = AgentFamilyStatus::Idle;
    row.activity = Some(AgentObserveActivity::User);
    let value = row.to_value();
    assert_eq!(value["status"], "idle");
    assert_eq!(value["activity"], "user");

    row.status = AgentFamilyStatus::Inactive;
    row.activity = None;
    let value = row.to_value();
    assert_eq!(value["status"], "inactive");
    assert!(
        value.get("activity").is_none(),
        "a member with no live session omits the activity field"
    );
}

#[test]
fn message_ids_and_validation() {
    let id = create_agent_session_message_id();
    assert!(id.starts_with("agentmsg_"));
    assert!(is_agent_session_message_id(Some(&id)));
    assert!(!is_agent_session_message_id(Some("prompt123")));
    assert!(!is_agent_session_message_id(None));
    assert_eq!(
        normalize_agent_session_message("  hello  ").unwrap(),
        "hello"
    );
    assert!(normalize_agent_session_message("   ").is_err());
    assert!(normalize_agent_session_message("").is_err());
    let long = "x".repeat(DEFAULT_AGENT_MESSAGE_MAX_CHARS + 1);
    assert!(normalize_agent_session_message(&long).is_err());
    let at_limit = "x".repeat(DEFAULT_AGENT_MESSAGE_MAX_CHARS);
    assert!(normalize_agent_session_message(&at_limit).is_ok());
}

#[test]
fn target_and_capacity_guards() {
    assert_eq!(
        assert_direct_agent_message_target(" worker ").unwrap(),
        "worker"
    );
    assert!(assert_direct_agent_message_target("").is_err());
    for broadcast in ["*", "all", "All", "BROADCAST"] {
        let error = assert_direct_agent_message_target(broadcast).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Broadcast agent messaging is not supported"
        );
    }
    assert_agent_message_queue_capacity(3, 20).unwrap();
    let error = assert_agent_message_queue_capacity(20, 20).unwrap_err();
    assert_eq!(
        error.to_string(),
        "Target session has too many pending messages: 20 unfinished, limit is 20"
    );
}

#[test]
fn message_prompts_and_id_parsing() {
    let payload = AgentMessagePromptPayload {
        message: "keep going".to_string(),
        sender_name: "worker-1".to_string(),
        from_relationship: Some(AgentFamilyRelationship::Child),
    };
    let prompt = create_agent_session_message_prompt(&payload);
    assert_eq!(prompt, "[agent-message from child:worker-1]\n\nkeep going");
    // Header values are sanitized.
    let evil = AgentMessagePromptPayload {
        message: "m".to_string(),
        sender_name: "bad name!".to_string(),
        from_relationship: None,
    };
    assert_eq!(
        create_agent_session_message_prompt(&evil),
        "[agent-message from bad name!]\n\nm"
    );
    // Legacy transcript header parsing.
    let header = format!(
        "Agent-to-agent message received.\nSource: {AGENT_MESSAGE_SOURCE}\nTo: worker\nMessage id: {}",
        create_agent_session_message_id()
    );
    let parsed = parse_agent_session_message_prompt_id(&header).unwrap();
    assert!(parsed.starts_with("agentmsg_"));
    assert!(is_agent_session_message_prompt(&header));
    assert!(!is_agent_session_message_prompt("plain text"));
}

#[test]
fn the_custom_row_carries_the_ts_agent_message_shape() {
    let prompt = "[agent-message from child:lane]\n\nfinished the research";
    let from = json!({
        "activeSessionId": "child-1",
        "sessionId": "child-file",
        "sessionName": "lane",
        "runtimeKind": "subagent",
    });
    let target = json!({
        "activeSessionId": "parent-1",
        "sessionId": "parent-file",
        "runtimeKind": "top-level",
    });
    let row = create_agent_session_message_row(&AgentSessionMessageRowPayload {
        id: "agentmsg_1",
        prompt,
        message: "finished the research",
        from: &from,
        from_relationship: Some(AgentFamilyRelationship::Child),
        target: &target,
        timestamp: 123,
    });
    // TS `createAgentSessionMessage`: the custom role, the agent_message
    // type, the prompt as the content, display on, and the identity
    // details the `agent_message` UI reads.
    assert_eq!(row["role"], "custom");
    assert_eq!(row["customType"], AGENT_MESSAGE_CUSTOM_TYPE);
    assert_eq!(row["content"], prompt);
    assert_eq!(row["display"], true);
    assert_eq!(row["timestamp"], 123);
    assert_eq!(row["details"]["id"], "agentmsg_1");
    assert_eq!(row["details"]["message"], "finished the research");
    assert_eq!(row["details"]["from"], from);
    assert_eq!(row["details"]["fromRelationship"], "child");
    assert_eq!(row["details"]["target"], target);
    // An absent relationship omits the key (TS serializes `undefined`
    // away), not a null.
    let plain = create_agent_session_message_row(&AgentSessionMessageRowPayload {
        id: "agentmsg_2",
        prompt,
        message: "finished the research",
        from: &Value::Null,
        from_relationship: None,
        target: &target,
        timestamp: 124,
    });
    assert!(plain["details"].get("fromRelationship").is_none());
    assert_eq!(plain["details"]["from"], Value::Null);
}

#[test]
fn observe_limits_clamp() {
    assert_eq!(normalize_observe_limit(None).unwrap(), 8);
    assert_eq!(normalize_observe_limit(Some(50)).unwrap(), 50);
    assert!(normalize_observe_limit(Some(51)).is_err());
    assert!(normalize_observe_limit(Some(0)).is_err());
    assert_eq!(normalize_observe_max_chars(None).unwrap(), 800);
    assert_eq!(normalize_observe_max_chars(Some(80)).unwrap(), 80);
    assert!(normalize_observe_max_chars(Some(79)).is_err());
    assert!(normalize_observe_max_chars(Some(2_001)).is_err());
}

#[test]
fn observe_previews_truncate() {
    let user = pa_types::session::AgentMessage::User(pa_types::ai::UserMessage {
        content: pa_types::ai::UserContent::Text("short".to_string()),
        timestamp: 42,
        rest: serde_json::Map::default(),
    });
    let preview = create_agent_observe_message_preview(&user, 3, 800);
    assert_eq!(preview.index, 3);
    assert_eq!(preview.role, "user");
    assert_eq!(preview.timestamp, Some(42));
    assert_eq!(preview.text, "short");
    assert!(!preview.truncated);
    let long = pa_types::session::AgentMessage::User(pa_types::ai::UserMessage {
        content: pa_types::ai::UserContent::Text("x".repeat(100)),
        timestamp: 0,
        rest: serde_json::Map::default(),
    });
    let clipped = create_agent_observe_message_preview(&long, 0, 10);
    assert!(clipped.truncated);
    assert_eq!(clipped.text.chars().count(), 10);
}

/// A family of one parent, two siblings (one named "scout"), and two
/// children both named "dual".
fn family() -> Vec<AgentFamilyMember> {
    vec![
        AgentFamilyMember {
            relationship: AgentFamilyRelationship::Parent,
            id: "parent-1".to_string(),
            name: None,
            aliases: Vec::new(),
        },
        AgentFamilyMember {
            relationship: AgentFamilyRelationship::Sibling,
            id: "sib-1".to_string(),
            name: Some("scout".to_string()),
            aliases: Vec::new(),
        },
        AgentFamilyMember {
            relationship: AgentFamilyRelationship::Sibling,
            id: "sib-2".to_string(),
            name: None,
            aliases: Vec::new(),
        },
        AgentFamilyMember {
            relationship: AgentFamilyRelationship::Child,
            id: "kid-1".to_string(),
            name: Some("dual".to_string()),
            aliases: vec!["sub-kid1".to_string(), "sess-kid1".to_string()],
        },
        AgentFamilyMember {
            relationship: AgentFamilyRelationship::Child,
            id: "kid-2".to_string(),
            name: Some("dual".to_string()),
            aliases: Vec::new(),
        },
    ]
}

struct RecordingMessageController;

impl AgentMessageController for RecordingMessageController {
    fn family(&self) -> impl std::future::Future<Output = anyhow::Result<Vec<AgentFamilyMember>>> {
        std::future::ready(Ok(family()))
    }

    fn send_agent_message(
        &self,
        input: AgentMessageSendInput,
    ) -> impl std::future::Future<Output = anyhow::Result<AgentMessageReceipt>> {
        std::future::ready(Ok(AgentMessageReceipt {
            id: create_agent_session_message_id(),
            target_session_id: Some(format!("{}-session", input.target)),
            target: input.target,
            target_session_name: None,
            target_runtime_kind: Some("top-level".to_string()),
            message: input.message,
            delivery_status: AgentMessageDeliveryStatus::Delivered,
            delivery_mode: Some("steer"),
            receiver_role: input.receiver_role,
            delivered_at: Some("2024-01-01T00:00:00.000Z".to_string()),
            queued_at: None,
            digest_at: None,
        }))
    }
}

fn send_request(send: &crate::kernel::shared::HostHandlerFn, data: Value) -> anyhow::Result<Value> {
    // The handler futures here are plain (no tokio IO), so driving
    // them on the test executor is safe.
    futures::executor::block_on(send(crate::kernel::shared::HostRequestPayload {
        data,
        cell_source_code: None,
    }))
}

#[tokio::test]
async fn message_host_handler_round_trip() {
    let mut handlers = HostRequestHandlers::default();
    register_agent_message_host_handlers(
        std::sync::Arc::new(RecordingMessageController),
        &mut handlers,
    );
    let send = handlers.get("agent_message.send").unwrap().clone();

    // Role-addressed send resolves the name through the family.
    let receipt = send_request(
        &send,
        json!({
            "message": "  proceed  ",
            "receiver_role": "sibling",
            "receiver_name": " scout "
        }),
    )
    .unwrap();
    assert_eq!(receipt["target"]["activeSessionId"], "sib-1");
    assert_eq!(receipt["target"]["sessionId"], "sib-1-session");
    assert_eq!(receipt["target"]["runtimeKind"], "top-level");
    assert_eq!(receipt["message"], "proceed");
    assert_eq!(receipt["deliveryStatus"], "delivered");
    assert_eq!(receipt["receiverRole"], "sibling");
    assert!(receipt["id"].as_str().unwrap().starts_with("agentmsg_"));

    // Unnamed members resolve by id (TS agentFamilyMemberName).
    let by_id = send_request(
        &send,
        json!({ "message": "hi", "receiver_role": "sibling", "receiver_name": "sib-2" }),
    )
    .unwrap();
    assert_eq!(by_id["target"]["activeSessionId"], "sib-2");

    // Parent sends need no name.
    let parent = send_request(
        &send,
        json!({ "message": "reply to parent", "receiver_role": "parent" }),
    )
    .unwrap();
    assert_eq!(parent["target"]["activeSessionId"], "parent-1");
    let parent_named = send_request(
        &send,
        json!({ "message": "x", "receiver_role": "parent", "receiver_name": "p" }),
    )
    .unwrap_err();
    assert_eq!(
        parent_named.to_string(),
        "agent_message.send receiver_name must be omitted for parent messages"
    );

    // Contract errors carry the TS strings verbatim.
    let positional =
        send_request(&send, json!({ "target": "worker", "message": "hi" })).unwrap_err();
    assert_eq!(
        positional.to_string(),
        "positional agent_message.send targets are not supported; use receiver_role and receiver_name"
    );
    let no_role = send_request(&send, json!({ "message": "hi" })).unwrap_err();
    assert_eq!(
        no_role.to_string(),
        "agent_message.send receiver_role must be \"parent\", \"sibling\", or \"child\""
    );
    let missing_name =
        send_request(&send, json!({ "message": "hi", "receiver_role": "child" })).unwrap_err();
    assert_eq!(
        missing_name.to_string(),
        "agent_message.send receiver_name is required for sibling and child messages"
    );

    // Resolution failures keep the TS wording.
    let no_match = send_request(
        &send,
        json!({ "message": "hi", "receiver_role": "child", "receiver_name": "ghost" }),
    )
    .unwrap_err();
    assert_eq!(no_match.to_string(), "No child matches \"ghost\"");
    let ambiguous = send_request(
        &send,
        json!({ "message": "hi", "receiver_role": "child", "receiver_name": "dual" }),
    )
    .unwrap_err();
    assert_eq!(
        ambiguous.to_string(),
        "child selector \"dual\" is ambiguous"
    );

    // Aliased members resolve by every alias form (the daemon lists a
    // child's RLM child id and persisted session id as aliases).
    let by_child_alias = send_request(
        &send,
        json!({ "message": "hi", "receiver_role": "child", "receiver_name": "sub-kid1" }),
    )
    .unwrap();
    assert_eq!(by_child_alias["target"]["activeSessionId"], "kid-1");
    let by_session_alias = send_request(
        &send,
        json!({ "message": "hi", "receiver_role": "child", "receiver_name": "sess-kid1" }),
    )
    .unwrap();
    assert_eq!(by_session_alias["target"]["activeSessionId"], "kid-1");

    // Broadcast sends to every family member, all-settled.
    let broadcast =
        send_request(&send, json!({ "target": "all", "message": "  everyone  " })).unwrap();
    let receipts = broadcast["receipts"].as_array().expect("receipts");
    assert_eq!(receipts.len(), 5, "{broadcast:?}");
    assert!(receipts
        .iter()
        .all(|receipt| receipt["message"] == "everyone"));

    // The removed roster request answers with the TS migration error.
    let list_agents = handlers.get("agent_message.list_agents").unwrap().clone();
    let removed = send_request(&list_agents, json!({})).unwrap_err();
    assert!(removed.to_string().starts_with(
        "agent_message.list_agents was removed; the family roster now lives in agent_observe.list_agents()"
    ));
}

#[tokio::test]
async fn broadcast_without_family_is_empty_and_failures_settle() {
    struct NoFamilyController;
    impl AgentMessageController for NoFamilyController {
        fn family(
            &self,
        ) -> impl std::future::Future<Output = anyhow::Result<Vec<AgentFamilyMember>>> {
            std::future::ready(Ok(Vec::new()))
        }
        fn send_agent_message(
            &self,
            _input: AgentMessageSendInput,
        ) -> impl std::future::Future<Output = anyhow::Result<AgentMessageReceipt>> {
            std::future::ready(Err(anyhow::anyhow!("no route")))
        }
    }
    struct LoneFamilyController;
    impl AgentMessageController for LoneFamilyController {
        fn family(
            &self,
        ) -> impl std::future::Future<Output = anyhow::Result<Vec<AgentFamilyMember>>> {
            std::future::ready(Ok(vec![AgentFamilyMember {
                relationship: AgentFamilyRelationship::Sibling,
                id: "sib-1".to_string(),
                name: None,
                aliases: Vec::new(),
            }]))
        }
        fn send_agent_message(
            &self,
            _input: AgentMessageSendInput,
        ) -> impl std::future::Future<Output = anyhow::Result<AgentMessageReceipt>> {
            std::future::ready(Err(anyhow::anyhow!("peer unreachable")))
        }
    }
    let mut handlers = HostRequestHandlers::default();
    register_agent_message_host_handlers(std::sync::Arc::new(NoFamilyController), &mut handlers);
    let send = handlers.get("agent_message.send").unwrap().clone();
    let broadcast = send_request(&send, json!({ "target": "all", "message": "hi" })).unwrap();
    assert_eq!(broadcast["receipts"].as_array().map(Vec::len), Some(0));

    // A role send against an empty family: no parent matches.
    let no_parent =
        send_request(&send, json!({ "message": "hi", "receiver_role": "parent" })).unwrap_err();
    assert_eq!(no_parent.to_string(), "No parent matches the current agent");

    // One-member family with a failing send: the receipt records the
    // error instead of aborting the broadcast.
    let mut handlers = HostRequestHandlers::default();
    register_agent_message_host_handlers(std::sync::Arc::new(LoneFamilyController), &mut handlers);
    let send = handlers.get("agent_message.send").unwrap().clone();
    let broadcast = send_request(&send, json!({ "target": "all", "message": "hi" })).unwrap();
    let receipts = broadcast["receipts"].as_array().expect("receipts");
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0]["target"], "sib-1");
    assert_eq!(receipts[0]["error"], "peer unreachable");
}
