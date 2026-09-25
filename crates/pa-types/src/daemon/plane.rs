//! Daemon command planes (TS `DAEMON_COMMAND_PLANE`): which socket a
//! command belongs on. Session-plane commands address exactly one live
//! session and may travel over a direct worker peer link; control-plane
//! commands belong to the supervisor (roster, lifecycle, restarts) or
//! mutate supervisor-owned state.
//!
//! The worker enforces this table for direct peer connections (a session
//! client may only send session-plane commands for its own session) and the
//! routed clients in pa-tui use it to pick the socket per request, so the
//! table is the shared wire contract and lives here.

/// The plane one command type belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DaemonCommandPlane {
    /// Serves one session; valid on a direct worker peer link.
    Session,
    /// Supervisor-owned; never valid on a direct worker peer link.
    Control,
}

/// TS `DAEMON_COMMAND_PLANE`: every session-plane command the TS product
/// defines has an entry; all other commands, known or unknown, are control
/// (never forwarded on a peer link).
pub fn command_plane(command_type: &str) -> DaemonCommandPlane {
    use DaemonCommandPlane::{Control, Session};
    match command_type {
        "attach"
        | "detach"
        | "prompt"
        | "cancel_prompt_admission"
        | "prompt_and_wait"
        | "steer"
        | "follow_up"
        | "restore_next_turn"
        | "restore_actions"
        | "append_custom_message"
        | "resume_queue"
        | "abort"
        | "abort_and_send_queued"
        | "start_side_question"
        | "abort_side_question"
        | "execute_bash"
        | "abort_bash"
        | "list_kernel_bash"
        | "tail_kernel_bash"
        | "kill_kernel_bash"
        | "cancel_rlm_child"
        | "delete_rlm_subagent"
        | "wait_for_idle"
        | "wait_for_headless_completion"
        | "get_session_header"
        | "get_state"
        | "get_connection_state"
        | "get_messages"
        | "get_rlm_children"
        | "get_session_stats"
        | "get_context_tree"
        | "get_commands"
        | "get_resource_snapshot"
        | "get_mcp_connections"
        | "replace_acp_mcp_servers"
        | "get_model_catalog"
        | "get_available_models"
        | "get_queue"
        | "mutate_queued_message"
        | "clear_queue"
        | "abort_and_clear_queue"
        | "acquire_session_input_pause"
        | "release_session_input_pause"
        | "set_model"
        | "cycle_model"
        | "set_scoped_models"
        | "set_thinking_level"
        | "set_service_tier"
        | "cycle_thinking_level"
        | "set_transport"
        | "set_steering_mode"
        | "set_follow_up_mode"
        | "set_auto_compaction"
        | "set_auto_retry"
        | "compact"
        | "refine"
        | "abort_compaction"
        | "abort_branch_summary"
        | "abort_retry"
        | "execute_bash_and_wait"
        | "reload"
        | "new_session"
        | "switch_session"
        | "fork"
        | "navigate_tree"
        | "import_jsonl"
        | "export_html"
        | "export_jsonl"
        | "get_rlm_max_depth_status"
        | "set_rlm_max_depth"
        | "get_session_context"
        | "get_session_tree"
        | "get_user_messages_for_forking"
        | "get_last_assistant_text"
        | "get_system_prompt"
        | "get_tool_definition"
        | "set_session_entry_label"
        | "extension_ui_response" => Session,
        _ => Control,
    }
}

/// TS `isSessionPlaneDaemonCommand`.
pub fn is_session_plane_daemon_command(command_type: &str) -> bool {
    command_plane(command_type) == DaemonCommandPlane::Session
}

/// TS `READ_ONLY_DAEMON_COMMANDS`, verbatim: the commands that never mutate
/// daemon state. Everything else counts as a mutation for the update-flow
/// admission gate and the in-flight mutation drain (`attach`/`reattach` are
/// intentionally read-only, so a reconnecting client is never fenced out).
const READ_ONLY_DAEMON_COMMANDS: &[&str] = &[
    "ack_result",
    "list",
    "list_saved_sessions",
    "list_agent_peers",
    "get_direct_worker_transport",
    "attach",
    "reattach",
    "roster_subscribe",
    "roster_unsubscribe",
    "agent_messages_status",
    "wait_for_idle",
    "list_kernel_bash",
    "tail_kernel_bash",
    "get_session_header",
    "get_state",
    "get_connection_state",
    "get_messages",
    "get_rlm_children",
    "get_session_stats",
    "get_context_tree",
    "get_commands",
    "get_resource_snapshot",
    "get_mcp_connections",
    "get_model_catalog",
    "get_available_models",
    "get_queue",
    "cron_list",
    "heartbeats_list",
    "update_restore_status",
    "heartbeat_get",
    "get_session_context",
    "get_session_tree",
    "get_user_messages_for_forking",
    "get_last_assistant_text",
    "get_system_prompt",
    "get_rlm_max_depth_status",
    "get_tool_definition",
];

/// TS `isDaemonMutatingCommand`: a command mutates daemon state unless it is
/// in the read-only table.
pub fn is_daemon_mutating_command(command_type: &str) -> bool {
    !READ_ONLY_DAEMON_COMMANDS.contains(&command_type)
}

/// TS `UPDATE_RESTART_DRAIN_COMMANDS`: mutations that still pass the
/// admission gate while the prepare transaction is `Draining` — they cancel
/// or drain in-flight session work, so letting them through shortens the
/// drain instead of fencing it off.
pub fn is_update_drain_command(command_type: &str) -> bool {
    matches!(
        command_type,
        "extension_ui_response"
            | "abort"
            | "abort_bash"
            | "kill_kernel_bash"
            | "abort_branch_summary"
            | "abort_compaction"
            | "abort_retry"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The plane assignments the direct-attach path depends on: the session
    /// commands a peer may send, and the control commands it must not.
    #[test]
    fn planes_match_ts() {
        for session in [
            "attach",
            "detach",
            "prompt",
            "prompt_and_wait",
            "get_state",
            "get_last_assistant_text",
            "start_side_question",
        ] {
            assert!(is_session_plane_daemon_command(session), "{session}");
        }
        for control in [
            "list",
            "get_direct_worker_transport",
            "create",
            "kill",
            "rename",
            "set_session_name",
            "shutdown",
            "restart",
            "retry_worker",
        ] {
            assert!(!is_session_plane_daemon_command(control), "{control}");
        }
        // Unknown commands never ride a peer link.
        assert!(!is_session_plane_daemon_command("not_a_command"));
    }

    /// TS `READ_ONLY_DAEMON_COMMANDS` membership as the admission gate reads
    /// it: reads and attach pass, session work and lifecycle mutate.
    #[test]
    fn mutating_classification_matches_ts() {
        for read_only in [
            "ack_result",
            "list",
            "attach",
            "reattach",
            "get_state",
            "get_messages",
            "get_queue",
            "wait_for_idle",
            "heartbeats_list",
            "get_last_assistant_text",
        ] {
            assert!(!is_daemon_mutating_command(read_only), "{read_only}");
        }
        for mutating in [
            "prompt",
            "create",
            "kill",
            "shutdown",
            "restart",
            "send_message",
            "compact",
            "set_model",
            "clear_queue",
            "rename",
            "prepare_update_restart",
            "commit_update_restart",
        ] {
            assert!(is_daemon_mutating_command(mutating), "{mutating}");
        }
    }

    /// TS `UPDATE_RESTART_DRAIN_COMMANDS`, verbatim.
    #[test]
    fn update_drain_commands_match_ts() {
        for drain in [
            "extension_ui_response",
            "abort",
            "abort_bash",
            "abort_branch_summary",
            "abort_compaction",
            "abort_retry",
        ] {
            assert!(is_update_drain_command(drain), "{drain}");
        }
        // Everything else still fences off during `Draining`.
        assert!(!is_update_drain_command("prompt"));
        assert!(!is_update_drain_command("create"));
    }
}
