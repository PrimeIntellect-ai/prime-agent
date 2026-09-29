//! Worker summary/wire unit tests (moved with their concerns).
use super::*;

/// The delivery's relationship label is edge-derived: a subagent
/// sender whose durable parent edge points at this session is a
/// child; a subagent from another family never is, no matter its
/// runtime kind (the mislabeled-ack regression — sibling lanes'
/// messages must not render "from child:").
#[test]
fn sender_child_edge_decides_the_relationship_label() {
    let true_child = json!({
        "activeSessionId": "ddd444",
        "runtimeKind": "subagent",
        "parentSessionId": "sess-a",
    });
    assert!(sender_parent_edge_is(
        &true_child,
        Some("sess-a"),
        "aaa111",
        None
    ));
    let live_child = json!({
        "activeSessionId": "eee555",
        "runtimeKind": "subagent",
        "parentActiveSessionId": "aaa111",
    });
    assert!(sender_parent_edge_is(
        &live_child,
        Some("sess-a"),
        "aaa111",
        None
    ));
    let foreign_child = json!({
        "activeSessionId": "fff666",
        "runtimeKind": "subagent",
        "parentSessionId": "sess-zz",
    });
    assert!(!sender_parent_edge_is(
        &foreign_child,
        Some("sess-a"),
        "aaa111",
        None
    ));
    let edgeless = json!({ "activeSessionId": "ggg777", "runtimeKind": "subagent" });
    assert!(!sender_parent_edge_is(
        &edgeless,
        Some("sess-a"),
        "aaa111",
        None
    ));
    let moved_child = json!({
        "activeSessionId": "hhh888",
        "runtimeKind": "subagent",
        "parentSessionPath": "/old/root/sessions/01a0d0a5-e954-71b7-8479-8dc7980768a1.jsonl",
    });
    assert!(sender_parent_edge_is(
        &moved_child,
        Some("sess-a"),
        "aaa111",
        Some(std::path::Path::new(
            "/new/root/sessions/01a0d0a5-e954-71b7-8479-8dc7980768a1.jsonl"
        )),
    ));
}

/// A message-less top-level session is a draft (hidden from the agents
/// view); a session with messages is live; a resident subagent is live
/// before its first message (TS `activeLifecycleForSession`).
#[test]
fn summary_lifecycle_is_message_based() {
    let empty = SessionCore::test_core(None, "/tmp".to_string());
    assert_eq!(
        session_summary(
            &empty, "default", None, None, /*bash_running=*/ false,
            /*quota_parked=*/ false
        )
        .lifecycle,
        "draft"
    );
    let mut subagent = SessionCore::test_core(None, "/tmp".to_string());
    subagent.runtime_kind = "subagent".to_string();
    assert_eq!(
        session_summary(
            &subagent, "default", None, None, /*bash_running=*/ false,
            /*quota_parked=*/ false
        )
        .lifecycle,
        "live"
    );
    // The busy-flip roster delta fires before the store flushes the
    // admitted prompt; a busy turn is live at that wire moment (TS
    // reads the runtime's in-memory messages, which already hold it).
    let mut busy = SessionCore::test_core(None, "/tmp".to_string());
    busy.busy = true;
    busy.running_tool_calls.insert("call-1".to_string());
    // `isRunningTools` is the streaming gate over the in-flight tool
    // set (TS `isStreaming && pendingToolCalls.size > 0`): tools in
    // flight read true only while the turn streams.
    assert!(
        session_summary(
            &busy, "default", None, None, /*bash_running=*/ false,
            /*quota_parked=*/ false
        )
        .is_running_tools
    );
    busy.running_tool_calls.clear();
    assert!(
        !session_summary(
            &busy, "default", None, None, /*bash_running=*/ false,
            /*quota_parked=*/ false
        )
        .is_running_tools
    );
    busy.running_tool_calls.insert("call-1".to_string());
    busy.busy = false;
    assert!(
        !session_summary(
            &busy, "default", None, None, /*bash_running=*/ false,
            /*quota_parked=*/ false
        )
        .is_running_tools
    );
    // The user bash state rides the summary as its own flag (TS
    // `session.isBashRunning`).
    assert_eq!(
        session_summary(
            &busy, "default", None, None, /*bash_running=*/ true, /*quota_parked=*/ false
        )
        .is_bash_running,
        Some(true)
    );
    busy.busy = true;
    assert_eq!(
        session_summary(
            &busy, "default", None, None, /*bash_running=*/ false,
            /*quota_parked=*/ false
        )
        .lifecycle,
        "live"
    );
    let dir = std::env::temp_dir().join(format!("pa-worker-lc-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut session = crate::session_store::SessionFile::create("/tmp", None, 0);
    let path = dir.join(crate::session_store::session_file_name(
        session.session_id(),
    ));
    session.set_path(path);
    session.append_message(&serde_json::json!({
        "role": "user", "content": "hi", "timestamp": 1u64
    }));
    session.rewrite().unwrap();
    let with_message = SessionCore::test_core(Some(session), "/tmp".to_string());
    assert_eq!(
        session_summary(
            &with_message,
            "default",
            None,
            None,
            /*bash_running=*/ false,
            /*quota_parked=*/ false
        )
        .lifecycle,
        "live"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn display_ids_are_twelve_hex() {
    let id = crate::util::new_display_id();
    assert_eq!(id.len(), 12);
    assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
}
