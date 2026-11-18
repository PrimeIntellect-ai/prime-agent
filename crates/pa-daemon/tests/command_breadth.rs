//! Daemon command-type breadth coverage: every wire fixture below must parse,
//! keep its wire `type`, and route by selector.

use pa_daemon::protocol::command_active_session_id;
use pa_daemon::protocol::command_type_name;
use pa_daemon::protocol::parse_daemon_command_line;

/// Minimal wire fixture per command type: the fields the `DaemonCommand` union
/// requires on the wire (everything else is optional or in the lossless `rest`
/// map); the session selector is "sess" everywhere a command carries one.
const WIRE_FIXTURES: &[(&str, &str)] = &[
    ("ack_result", r#"{"type": "ack_result", "commandId": "c1"}"#),
    ("list", r#"{"type": "list"}"#),
    (
        "list_agent_peers",
        r#"{"type": "list_agent_peers", "workerToken": "token"}"#,
    ),
    (
        "get_direct_worker_transport",
        r#"{"type": "get_direct_worker_transport", "activeSessionId": "sess"}"#,
    ),
    ("roster_subscribe", r#"{"type": "roster_subscribe"}"#),
    ("roster_unsubscribe", r#"{"type": "roster_unsubscribe"}"#),
    ("list_saved_sessions", r#"{"type": "list_saved_sessions"}"#),
    ("create", r#"{"type": "create"}"#),
    ("attach", r#"{"type": "attach", "activeSessionId": "sess"}"#),
    (
        "reattach",
        r#"{"type": "reattach", "activeSessionId": "sess", "targetActiveSessionId": "target"}"#,
    ),
    ("detach", r#"{"type": "detach"}"#),
    (
        "complete_owned_session",
        r#"{"type": "complete_owned_session", "activeSessionId": "sess"}"#,
    ),
    (
        "promote_owned_session",
        r#"{"type": "promote_owned_session", "activeSessionId": "sess"}"#,
    ),
    ("kill", r#"{"type": "kill", "activeSessionId": "sess"}"#),
    (
        "rename",
        r#"{"type": "rename", "activeSessionId": "sess", "name": "x"}"#,
    ),
    (
        "prompt",
        r#"{"type": "prompt", "activeSessionId": "sess", "message": "x"}"#,
    ),
    (
        "cancel_prompt_admission",
        r#"{"type": "cancel_prompt_admission", "activeSessionId": "sess", "admissionId": "a1"}"#,
    ),
    (
        "prompt_and_wait",
        r#"{"type": "prompt_and_wait", "activeSessionId": "sess", "message": "x"}"#,
    ),
    (
        "steer",
        r#"{"type": "steer", "activeSessionId": "sess", "message": "x"}"#,
    ),
    (
        "follow_up",
        r#"{"type": "follow_up", "activeSessionId": "sess", "message": "x"}"#,
    ),
    (
        "restore_next_turn",
        r#"{"type": "restore_next_turn", "activeSessionId": "sess", "messages": [ ]}"#,
    ),
    (
        "restore_actions",
        r#"{"type": "restore_actions", "activeSessionId": "sess", "snapshot": { }}"#,
    ),
    (
        "append_custom_message",
        r#"{"type": "append_custom_message", "activeSessionId": "sess", "message": "x"}"#,
    ),
    (
        "resume_queue",
        r#"{"type": "resume_queue", "activeSessionId": "sess"}"#,
    ),
    (
        "send_message",
        r#"{"type": "send_message", "targetActiveSessionId": "target", "message": "x"}"#,
    ),
    (
        "agent_messages_status",
        r#"{"type": "agent_messages_status"}"#,
    ),
    (
        "agent_messages_pause",
        r#"{"type": "agent_messages_pause"}"#,
    ),
    (
        "agent_messages_resume",
        r#"{"type": "agent_messages_resume"}"#,
    ),
    (
        "agent_messages_clear",
        r#"{"type": "agent_messages_clear", "activeSessionId": "sess"}"#,
    ),
    ("abort", r#"{"type": "abort", "activeSessionId": "sess"}"#),
    (
        "start_side_question",
        r#"{"type": "start_side_question", "activeSessionId": "sess", "sideQuestionId": "sq1", "question": "q"}"#,
    ),
    (
        "abort_side_question",
        r#"{"type": "abort_side_question", "activeSessionId": "sess", "sideQuestionId": "sq1"}"#,
    ),
    (
        "execute_bash",
        r#"{"type": "execute_bash", "activeSessionId": "sess", "command": "true"}"#,
    ),
    (
        "execute_bash_and_wait",
        r#"{"type": "execute_bash_and_wait", "activeSessionId": "sess", "command": "true"}"#,
    ),
    (
        "abort_bash",
        r#"{"type": "abort_bash", "activeSessionId": "sess"}"#,
    ),
    (
        "cancel_rlm_child",
        r#"{"type": "cancel_rlm_child", "activeSessionId": "sess", "childId": "c1"}"#,
    ),
    (
        "delete_rlm_subagent",
        r#"{"type": "delete_rlm_subagent", "activeSessionId": "sess", "childId": "c1"}"#,
    ),
    (
        "wait_for_idle",
        r#"{"type": "wait_for_idle", "activeSessionId": "sess"}"#,
    ),
    (
        "wait_for_headless_completion",
        r#"{"type": "wait_for_headless_completion", "activeSessionId": "sess"}"#,
    ),
    (
        "get_session_header",
        r#"{"type": "get_session_header", "activeSessionId": "sess"}"#,
    ),
    (
        "get_state",
        r#"{"type": "get_state", "activeSessionId": "sess"}"#,
    ),
    (
        "get_connection_state",
        r#"{"type": "get_connection_state", "activeSessionId": "sess"}"#,
    ),
    (
        "get_messages",
        r#"{"type": "get_messages", "activeSessionId": "sess"}"#,
    ),
    (
        "get_rlm_children",
        r#"{"type": "get_rlm_children", "activeSessionId": "sess"}"#,
    ),
    (
        "get_session_stats",
        r#"{"type": "get_session_stats", "activeSessionId": "sess"}"#,
    ),
    (
        "get_context_tree",
        r#"{"type": "get_context_tree", "activeSessionId": "sess"}"#,
    ),
    (
        "get_commands",
        r#"{"type": "get_commands", "activeSessionId": "sess"}"#,
    ),
    (
        "get_resource_snapshot",
        r#"{"type": "get_resource_snapshot", "activeSessionId": "sess"}"#,
    ),
    (
        "replace_acp_mcp_servers",
        r#"{"type": "replace_acp_mcp_servers", "activeSessionId": "sess", "ownerId": "o1", "servers": [ ]}"#,
    ),
    (
        "get_model_catalog",
        r#"{"type": "get_model_catalog", "activeSessionId": "sess"}"#,
    ),
    (
        "get_available_models",
        r#"{"type": "get_available_models", "activeSessionId": "sess"}"#,
    ),
    (
        "get_queue",
        r#"{"type": "get_queue", "activeSessionId": "sess"}"#,
    ),
    (
        "mutate_queued_message",
        r#"{"type": "mutate_queued_message", "activeSessionId": "sess", "lane": "steering", "index": 0, "expectedText": "x", "mutation": { "type": "delete" }}"#,
    ),
    (
        "clear_queue",
        r#"{"type": "clear_queue", "activeSessionId": "sess"}"#,
    ),
    (
        "abort_and_clear_queue",
        r#"{"type": "abort_and_clear_queue", "activeSessionId": "sess"}"#,
    ),
    (
        "acquire_session_input_pause",
        r#"{"type": "acquire_session_input_pause", "activeSessionId": "sess", "leaseKey": "k"}"#,
    ),
    (
        "release_session_input_pause",
        r#"{"type": "release_session_input_pause", "activeSessionId": "sess", "pauseId": "p"}"#,
    ),
    ("cron_list", r#"{"type": "cron_list"}"#),
    ("heartbeats_list", r#"{"type": "heartbeats_list"}"#),
    (
        "heartbeat_manage",
        r#"{"type": "heartbeat_manage", "activeSessionId": "sess", "jobId": "j", "action": "pause"}"#,
    ),
    (
        "cron_add",
        r#"{"type": "cron_add", "activeSessionId": "sess", "schedule": "0 0 * * *", "prompt": "p"}"#,
    ),
    ("cron_cancel", r#"{"type": "cron_cancel", "jobId": "j"}"#),
    (
        "heartbeat_get",
        r#"{"type": "heartbeat_get", "activeSessionId": "sess"}"#,
    ),
    (
        "heartbeat_set",
        r#"{"type": "heartbeat_set", "activeSessionId": "sess", "schedule": "0 0 * * *", "prompt": "p"}"#,
    ),
    (
        "heartbeat_update",
        r#"{"type": "heartbeat_update", "activeSessionId": "sess", "action": "pause"}"#,
    ),
    (
        "set_model",
        r#"{"type": "set_model", "activeSessionId": "sess", "provider": "prov", "modelId": "m"}"#,
    ),
    (
        "cycle_model",
        r#"{"type": "cycle_model", "activeSessionId": "sess"}"#,
    ),
    (
        "set_scoped_models",
        r#"{"type": "set_scoped_models", "activeSessionId": "sess", "scopedModels": [ ]}"#,
    ),
    (
        "set_thinking_level",
        r#"{"type": "set_thinking_level", "activeSessionId": "sess", "level": "high"}"#,
    ),
    (
        "cycle_thinking_level",
        r#"{"type": "cycle_thinking_level", "activeSessionId": "sess"}"#,
    ),
    (
        "set_service_tier",
        r#"{"type": "set_service_tier", "activeSessionId": "sess"}"#,
    ),
    (
        "set_transport",
        r#"{"type": "set_transport", "activeSessionId": "sess", "transport": "sse"}"#,
    ),
    (
        "set_steering_mode",
        r#"{"type": "set_steering_mode", "activeSessionId": "sess", "mode": "all"}"#,
    ),
    (
        "set_follow_up_mode",
        r#"{"type": "set_follow_up_mode", "activeSessionId": "sess", "mode": "all"}"#,
    ),
    (
        "set_auto_compaction",
        r#"{"type": "set_auto_compaction", "activeSessionId": "sess", "enabled": true}"#,
    ),
    (
        "set_auto_retry",
        r#"{"type": "set_auto_retry", "activeSessionId": "sess", "enabled": true}"#,
    ),
    (
        "compact",
        r#"{"type": "compact", "activeSessionId": "sess"}"#,
    ),
    ("refine", r#"{"type": "refine", "activeSessionId": "sess"}"#),
    (
        "abort_compaction",
        r#"{"type": "abort_compaction", "activeSessionId": "sess"}"#,
    ),
    (
        "abort_branch_summary",
        r#"{"type": "abort_branch_summary", "activeSessionId": "sess"}"#,
    ),
    (
        "abort_retry",
        r#"{"type": "abort_retry", "activeSessionId": "sess"}"#,
    ),
    ("reload", r#"{"type": "reload", "activeSessionId": "sess"}"#),
    (
        "new_session",
        r#"{"type": "new_session", "activeSessionId": "sess"}"#,
    ),
    (
        "switch_session",
        r#"{"type": "switch_session", "activeSessionId": "sess", "sessionPath": "/tmp/x.jsonl"}"#,
    ),
    (
        "fork",
        r#"{"type": "fork", "activeSessionId": "sess", "entryId": "e"}"#,
    ),
    (
        "navigate_tree",
        r#"{"type": "navigate_tree", "activeSessionId": "sess", "targetId": "t"}"#,
    ),
    (
        "import_jsonl",
        r#"{"type": "import_jsonl", "activeSessionId": "sess", "inputPath": "/tmp/in"}"#,
    ),
    (
        "export_html",
        r#"{"type": "export_html", "activeSessionId": "sess"}"#,
    ),
    (
        "export_jsonl",
        r#"{"type": "export_jsonl", "activeSessionId": "sess"}"#,
    ),
    (
        "set_session_name",
        r#"{"type": "set_session_name", "activeSessionId": "sess", "name": "x"}"#,
    ),
    (
        "get_rlm_max_depth_status",
        r#"{"type": "get_rlm_max_depth_status", "activeSessionId": "sess"}"#,
    ),
    (
        "set_rlm_max_depth",
        r#"{"type": "set_rlm_max_depth", "activeSessionId": "sess", "maxDepth": 2}"#,
    ),
    (
        "rename_saved_session",
        r#"{"type": "rename_saved_session", "sessionPath": "/tmp/x.jsonl", "name": "x"}"#,
    ),
    (
        "delete_saved_session",
        r#"{"type": "delete_saved_session", "sessionPath": "/tmp/x.jsonl"}"#,
    ),
    (
        "get_session_context",
        r#"{"type": "get_session_context", "activeSessionId": "sess"}"#,
    ),
    (
        "get_session_tree",
        r#"{"type": "get_session_tree", "activeSessionId": "sess"}"#,
    ),
    (
        "get_user_messages_for_forking",
        r#"{"type": "get_user_messages_for_forking", "activeSessionId": "sess"}"#,
    ),
    (
        "get_last_assistant_text",
        r#"{"type": "get_last_assistant_text", "activeSessionId": "sess"}"#,
    ),
    (
        "get_system_prompt",
        r#"{"type": "get_system_prompt", "activeSessionId": "sess"}"#,
    ),
    (
        "get_tool_definition",
        r#"{"type": "get_tool_definition", "activeSessionId": "sess", "name": "x"}"#,
    ),
    (
        "set_session_entry_label",
        r#"{"type": "set_session_entry_label", "activeSessionId": "sess", "entryId": "e"}"#,
    ),
    (
        "prepare_update_restart",
        r#"{"type": "prepare_update_restart"}"#,
    ),
    (
        "retry_worker",
        r#"{"type": "retry_worker", "activeSessionId": "sess"}"#,
    ),
    ("restart", r#"{"type": "restart"}"#),
    ("shutdown", r#"{"type": "shutdown"}"#),
    (
        "worker_register",
        r#"{"type": "worker_register", "activeSessionId": "sess", "socketPath": "/tmp/w.sock", "workerInstanceId": "wi", "token": "t", "pid": 1}"#,
    ),
    (
        "worker_roster_delta",
        r#"{"type": "worker_roster_delta", "workerToken": "token", "summary": { }}"#,
    ),
    (
        "get_worker_peer_transport",
        r#"{"type": "get_worker_peer_transport", "workerToken": "token", "targetActiveSessionId": "target"}"#,
    ),
    (
        "commit_update_restart",
        r#"{"type": "commit_update_restart"}"#,
    ),
    (
        "update_restore_status",
        r#"{"type": "update_restore_status"}"#,
    ),
    (
        "get_mcp_connections",
        r#"{"type": "get_mcp_connections", "activeSessionId": "sess"}"#,
    ),
    (
        "mark_anthropic_warning_shown",
        r#"{"type": "mark_anthropic_warning_shown", "activeSessionId": "sess"}"#,
    ),
    (
        "list_persistent_shells",
        r#"{"type": "list_persistent_shells"}"#,
    ),
    (
        "tail_persistent_shell",
        r#"{"type": "tail_persistent_shell", "shellId": "s", "lines": 50}"#,
    ),
    (
        "kill_persistent_shell",
        r#"{"type": "kill_persistent_shell", "shellId": "s"}"#,
    ),
    (
        "get_session_messages",
        r#"{"type": "get_session_messages", "activeSessionId": "sess", "start": -10, "limit": 10, "roles": ["*"]}"#,
    ),
];

#[test]
fn every_command_type_parses_and_routes() {
    for (type_name, wire) in WIRE_FIXTURES {
        // String concat keeps the raw fixture braces intact (a format! call would treat them as
        // placeholders).
        let line = r#"{"type":"command","id":"c1","protocol":{"name":"prime-agent.daemon","version":7},"command":"#
            .to_string()
            + wire
            + "}";
        let envelope = parse_daemon_command_line(&line)
            .unwrap_or_else(|e| panic!("{type_name} must parse: {e}"));
        assert_eq!(
            command_type_name(&envelope.command),
            *type_name,
            "router must preserve the wire type"
        );
        let selector = command_active_session_id(&envelope.command);
        let wire_has_selector = wire.contains("activeSessionId");
        assert_eq!(
            selector.is_some(),
            wire_has_selector,
            "{type_name}: session selector mismatch"
        );
        assert_eq!(selector, wire_has_selector.then_some("sess"));
    }
}

/// Unknown types keep the TS wire error, not a parse accident.
#[test]
fn unknown_type_keeps_the_ts_error_string() {
    let line = r#"{"type":"command","id":"c1","protocol":{"name":"prime-agent.daemon","version":7},"command":{"type":"not_a_command"}}"#;
    let error = parse_daemon_command_line(line).unwrap_err();
    assert_eq!(error.to_string(), "Unknown daemon command: not_a_command");

    // A known type with a malformed body is a malformed command, not unknown (the TS second-pass
    // error class).
    let line = r#"{"type":"command","id":"c2","protocol":{"name":"prime-agent.daemon","version":7},"command":{"type":"kill"}}"#;
    let error = parse_daemon_command_line(line).unwrap_err();
    assert_eq!(
        error.to_string(),
        "Invalid daemon command: malformed kill command"
    );
    assert!(!error.is_unknown_command());
}
