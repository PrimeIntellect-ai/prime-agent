//! Daemon wire protocol: thin adapter over `pa_types::daemon`.
//!
//! The shared wire contract lives in `pa-types` (ported from the TS daemon
//! protocol). This module re-exports it and adds the daemon-side mechanics:
//! command-envelope parsing with the TS error strings, capability sets, event
//! meta / replay helpers, and response constructors.

pub use pa_types::daemon::{
    DaemonClosingReason, DaemonCommand, DaemonCommandEnvelope as WireCommandEnvelope,
    DaemonCommandFrameType, DaemonErrorInfo, DaemonEventCursor, DaemonEventId, DaemonEventMeta,
    DaemonEventSequence, DaemonOutbound, DaemonProtocolInfo, DaemonReplayInfo, DaemonReplayStatus,
    DaemonResponse, DaemonResumeCursor, DaemonRuntimeIdentity, DaemonSavedSessionInfo,
    DaemonServerCapability, DaemonSessionClosedReason, DaemonSessionSnapshot,
    DaemonWorkerDescriptor, DaemonWorkerLifecycle, DurableDaemonCreateCommand,
    DAEMON_PROTOCOL_NAME, DAEMON_PROTOCOL_VERSION, DAEMON_SCHEMA_ID, DAEMON_SCHEMA_REVISION,
};
use serde_json::Value;

/// Minimum protocol version accepted in command envelopes (TS parity).
pub const DAEMON_COMMAND_ENVELOPE_MIN_PROTOCOL_VERSION: u64 = DAEMON_PROTOCOL_VERSION;
/// App version reported in `daemon_hello` for stale-daemon detection.
/// The product version the daemon reports in every `daemon_hello`
/// (`appVersion`): the TS daemon reports its own `VERSION` constant, and the
/// CLI's `doctor`/`status` "current" classification compares against the same
/// value, so this must stay the bare product version (the build identity
/// marker lives in `runtime.buildId`).
pub const DAEMON_APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Command types the daemon recognizes (TS `DAEMON_COMMAND_TYPES`, the 106
/// client command types in TS declared order, followed by the Rust-native
/// supervisor/worker frames the Rust daemon additionally accepts).
pub const KNOWN_COMMAND_TYPES: &[&str] = &[
    "ack_result",
    "list",
    "list_agent_peers",
    "get_direct_worker_transport",
    "roster_subscribe",
    "roster_unsubscribe",
    "list_saved_sessions",
    "create",
    "attach",
    "reattach",
    "detach",
    "complete_owned_session",
    "promote_owned_session",
    "kill",
    "rename",
    "prompt",
    "cancel_prompt_admission",
    "prompt_and_wait",
    "steer",
    "follow_up",
    "restore_next_turn",
    "restore_actions",
    "append_custom_message",
    "resume_queue",
    "send_message",
    "agent_messages_status",
    "agent_messages_pause",
    "agent_messages_resume",
    "agent_messages_clear",
    "abort",
    "start_side_question",
    "abort_side_question",
    "execute_bash",
    "execute_bash_and_wait",
    "abort_bash",
    "cancel_rlm_child",
    "delete_rlm_subagent",
    "wait_for_idle",
    "wait_for_headless_completion",
    "get_session_header",
    "get_state",
    "get_connection_state",
    "get_messages",
    "get_rlm_children",
    "get_session_stats",
    "get_context_tree",
    "get_commands",
    "get_resource_snapshot",
    "replace_acp_mcp_servers",
    "get_model_catalog",
    "get_available_models",
    "get_queue",
    "mutate_queued_message",
    "clear_queue",
    "abort_and_clear_queue",
    "acquire_session_input_pause",
    "release_session_input_pause",
    "cron_list",
    "heartbeats_list",
    "heartbeat_manage",
    "cron_add",
    "cron_cancel",
    "heartbeat_get",
    "heartbeat_set",
    "heartbeat_update",
    "set_model",
    "cycle_model",
    "set_scoped_models",
    "set_thinking_level",
    "cycle_thinking_level",
    "set_service_tier",
    "set_transport",
    "set_steering_mode",
    "set_follow_up_mode",
    "set_auto_compaction",
    "set_auto_retry",
    "compact",
    "refine",
    "abort_compaction",
    "abort_branch_summary",
    "abort_retry",
    "reload",
    "new_session",
    "switch_session",
    "fork",
    "navigate_tree",
    "import_jsonl",
    "export_html",
    "export_jsonl",
    "set_session_name",
    "get_rlm_max_depth_status",
    "set_rlm_max_depth",
    "rename_saved_session",
    "delete_saved_session",
    "get_session_context",
    "get_session_tree",
    "get_user_messages_for_forking",
    "get_last_assistant_text",
    "get_system_prompt",
    "get_tool_definition",
    "set_session_entry_label",
    "extension_ui_response",
    "prepare_update_restart",
    "retry_worker",
    "restart",
    "shutdown",
    "worker_register",
    "worker_roster_delta",
    "get_worker_peer_transport",
    "commit_update_restart",
    "update_restore_status",
    "get_mcp_connections",
    "set_mcp_static_token",
    "remove_mcp_connection",
];

/// Parsed client command envelope.
#[derive(Debug, Clone)]
pub struct DaemonCommandEnvelope {
    pub id: String,
    pub protocol: DaemonProtocolInfo,
    pub client_id: Option<String>,
    pub command: DaemonCommand,
}

/// Envelope parse failure with TS-parity error strings.
#[derive(Debug, Clone, thiserror::Error)]
pub enum EnvelopeParseError {
    #[error("Daemon commands require protocol {0} or newer")]
    ProtocolTooOld(u64),
    #[error("Unknown daemon command: {0}")]
    UnknownCommand(String),
    #[error("Invalid daemon command: {0}")]
    Invalid(String),
}

impl EnvelopeParseError {
    pub fn is_unknown_command(&self) -> bool {
        matches!(self, EnvelopeParseError::UnknownCommand(_))
    }
}

/// Parse one JSONL command line into an envelope. Non-envelope lines are
/// treated as bare commands (TS backward compat). Unknown command types are
/// preserved as an error so callers can reply with the exact TS wire error.
pub fn parse_daemon_command_line(line: &str) -> Result<DaemonCommandEnvelope, EnvelopeParseError> {
    let value: Value = serde_json::from_str(line)
        .map_err(|e| EnvelopeParseError::Invalid(format!("invalid JSON: {e}")))?;
    // Bare commands (no `type: "command"` envelope) are accepted directly.
    let (envelope_id, protocol, client_id, command_value) =
        if value.get("type").and_then(Value::as_str) == Some("command") {
            let obj = value.as_object().ok_or_else(|| {
                EnvelopeParseError::Invalid("command line is not an object".into())
            })?;
            let id = obj
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    EnvelopeParseError::Invalid("command envelope is missing id".into())
                })?
                .to_string();
            let protocol = obj
                .get("protocol")
                .ok_or(EnvelopeParseError::ProtocolTooOld(
                    DAEMON_COMMAND_ENVELOPE_MIN_PROTOCOL_VERSION,
                ))?;
            let name = protocol.get("name").and_then(Value::as_str).unwrap_or("");
            let version = protocol.get("version").and_then(Value::as_u64).unwrap_or(0);
            if name != DAEMON_PROTOCOL_NAME
                || version < DAEMON_COMMAND_ENVELOPE_MIN_PROTOCOL_VERSION
                || version > DAEMON_PROTOCOL_VERSION
            {
                return Err(EnvelopeParseError::ProtocolTooOld(
                    DAEMON_COMMAND_ENVELOPE_MIN_PROTOCOL_VERSION,
                ));
            }
            let client_id = match obj.get("clientId") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) => Some(s.clone()),
                Some(_) => {
                    return Err(EnvelopeParseError::Invalid(
                        "clientId must be a string".into(),
                    ))
                }
            };
            let command_value = obj.get("command").cloned().ok_or_else(|| {
                EnvelopeParseError::Invalid("command envelope is missing command".into())
            })?;
            (
                id,
                DaemonProtocolInfo {
                    name: name.to_string(),
                    version,
                },
                client_id,
                command_value,
            )
        } else {
            (
                value
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                current_protocol_info(),
                None,
                value.clone(),
            )
        };
    let command = match serde_json::from_value::<DaemonCommand>(command_value.clone()) {
        Ok(command) => command,
        Err(_) => {
            let type_name = command_value
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            if !KNOWN_COMMAND_TYPES.contains(&type_name.as_str()) {
                return Err(EnvelopeParseError::UnknownCommand(type_name));
            }
            return Err(EnvelopeParseError::Invalid(format!(
                "malformed {type_name} command"
            )));
        }
    };
    Ok(DaemonCommandEnvelope {
        id: envelope_id,
        protocol,
        client_id,
        command,
    })
}

/// Current protocol identity for this build.
pub fn current_protocol_info() -> DaemonProtocolInfo {
    DaemonProtocolInfo {
        name: DAEMON_PROTOCOL_NAME.to_string(),
        version: DAEMON_PROTOCOL_VERSION,
    }
}

/// TS `normalizeClientCapabilities`: filter against the supported set.
pub fn normalize_client_capabilities(capabilities: &[String]) -> Vec<String> {
    capabilities
        .iter()
        .filter(|cap| supported_client_capabilities().contains(&cap.as_str()))
        .cloned()
        .collect()
}

pub fn default_client_capabilities() -> Vec<String> {
    vec!["attach_snapshot".to_string(), "event_sequence".to_string()]
}

pub fn supported_client_capabilities() -> &'static [&'static str] {
    &[
        "attach_snapshot",
        "event_sequence",
        "extension_ui",
        "slim_attach",
        "chunked_snapshot",
        "client_owned_sessions",
    ]
}

pub fn default_server_capabilities() -> Vec<DaemonServerCapability> {
    supported_client_capabilities()
        .iter()
        .map(|cap| cap.to_string())
        .chain(
            [
                "delete_rlm_subagent",
                "heartbeat_catalog",
                "heartbeat_management",
                "model_catalog",
                "side_question_transcript",
                "transient_bash",
                "session_input_admission",
                "prompt_admission_cancellation",
                "owned_prompt_cancellation",
                "queue_message_mutation",
                "authoritative_child_roster",
                "owned_session_recovery_context",
                "rlm_quiescence_barrier",
                "session_input_pause",
                "acp_mcp_servers",
                "agent_roster",
                "direct_peer_transport",
            ]
            .iter()
            .map(|cap| cap.to_string()),
        )
        .map(|cap| cap.to_string())
        .collect()
}

/// Parse a client command line the way the TS supervisor does: only
/// `type: "command"` envelopes are accepted; bare commands fail with the
/// protocol error, because the supervisor has no pre-envelope clients.
pub fn parse_supervisor_command_line(
    line: &str,
) -> Result<DaemonCommandEnvelope, EnvelopeParseError> {
    let value: Value = serde_json::from_str(line)
        .map_err(|e| EnvelopeParseError::Invalid(format!("invalid JSON: {e}")))?;
    if value.get("type").and_then(Value::as_str) != Some("command") {
        return Err(EnvelopeParseError::ProtocolTooOld(
            DAEMON_COMMAND_ENVELOPE_MIN_PROTOCOL_VERSION,
        ));
    }
    parse_daemon_command_line(line)
}

/// `proc:<start_time>` identity of a process (shared platform contract).
/// `None` when the platform has no procfs identity.
pub fn process_start_id(pid: u32) -> Option<String> {
    pa_types::platform::process::process_start_id(pid)
}

/// Port of `createDaemonEventMeta`.
pub fn create_daemon_event_meta(
    active_session_id: &str,
    sequence: DaemonEventSequence,
    emitted_at: Option<String>,
    generation: Option<&str>,
) -> DaemonEventMeta {
    DaemonEventMeta {
        id: format!("{active_session_id}:{sequence}"),
        protocol: current_protocol_info(),
        active_session_id: Some(active_session_id.to_string()),
        sequence: Some(sequence),
        cursor: Some(DaemonEventCursor {
            generation: generation.unwrap_or(active_session_id).to_string(),
            sequence,
        }),
        emitted_at: emitted_at.unwrap_or_else(crate::util::now_iso),
        replayed: None,
    }
}

/// Port of `createDaemonReplayInfo`.
pub fn create_daemon_replay_info(
    resume_cursor: Option<&DaemonResumeCursor>,
    last_event_sequence: DaemonEventSequence,
    generation: &str,
) -> DaemonReplayInfo {
    let to_cursor = DaemonEventCursor {
        generation: generation.to_string(),
        sequence: last_event_sequence,
    };
    let Some(resume) = resume_cursor else {
        return DaemonReplayInfo {
            status: DaemonReplayStatus::Complete,
            from_sequence: None,
            to_sequence: last_event_sequence,
            from_cursor: None,
            to_cursor: Some(to_cursor),
            reason: None,
        };
    };
    let resume_sequence = resume
        .sequence
        .or(resume.event_sequence)
        .unwrap_or_default();
    let from_cursor = resume
        .generation
        .as_deref()
        .map(|generation| DaemonEventCursor {
            generation: generation.to_string(),
            sequence: resume_sequence,
        });
    let unavailable = |reason: &str| DaemonReplayInfo {
        status: DaemonReplayStatus::Unavailable,
        from_sequence: Some(resume_sequence),
        to_sequence: last_event_sequence,
        from_cursor: from_cursor.clone(),
        to_cursor: Some(to_cursor.clone()),
        reason: Some(reason.to_string()),
    };
    if let Some(from) = &from_cursor {
        if from.generation != generation {
            return unavailable("event_generation_changed");
        }
    }
    if resume_sequence > last_event_sequence {
        return unavailable("resume_cursor_ahead_of_session");
    }
    if resume_sequence == last_event_sequence {
        return DaemonReplayInfo {
            status: DaemonReplayStatus::Complete,
            from_sequence: Some(resume_sequence),
            to_sequence: last_event_sequence,
            from_cursor,
            to_cursor: Some(to_cursor),
            reason: None,
        };
    }
    unavailable("event_replay_not_available")
}

/// Response constructors with the TS shape (`type: "response"` included on
/// serialize by the `DaemonOutbound::Response` variant; standalone responses
/// add the tag here).
pub fn response_success(id: Option<&str>, command: &str, data: Option<Value>) -> DaemonResponse {
    DaemonResponse {
        id: id.map(str::to_string),
        command: command.to_string(),
        success: true,
        data,
        error: None,
        error_info: None,
    }
}

pub fn response_failure(
    id: Option<&str>,
    command: &str,
    error: &str,
    error_info: Option<DaemonErrorInfo>,
) -> DaemonResponse {
    DaemonResponse {
        id: id.map(str::to_string),
        command: command.to_string(),
        success: false,
        data: None,
        error: Some(error.to_string()),
        error_info,
    }
}

/// Serialize a standalone response line (`type: "response"`).
///
/// The key order matches the TS wire bytes (`daemon-protocol.ts` `success`/
/// `failure`): `id`, `type`, `command`, `success`, then `data` or
/// `error`/`errorInfo`. `type` is inserted at its TS position, not appended:
/// the JSON map preserves insertion order (the workspace's `serde_json`
/// runs with `preserve_order`), so a trailing insert would emit the tag last.
pub fn response_line(response: &DaemonResponse) -> Value {
    let mut obj = serde_json::Map::new();
    if let Some(id) = &response.id {
        obj.insert("id".to_string(), Value::String(id.clone()));
    }
    obj.insert("type".to_string(), Value::String("response".to_string()));
    obj.insert(
        "command".to_string(),
        Value::String(response.command.clone()),
    );
    obj.insert("success".to_string(), Value::Bool(response.success));
    match (&response.data, &response.error) {
        (Some(data), _) => {
            obj.insert("data".to_string(), data.clone());
        }
        (None, Some(error)) => {
            obj.insert("error".to_string(), Value::String(error.clone()));
        }
        (None, None) => {}
    }
    if let Some(error_info) = &response.error_info {
        obj.insert(
            "errorInfo".to_string(),
            serde_json::to_value(error_info).unwrap_or(Value::Null),
        );
    }
    Value::Object(obj)
}

/// Session selector carried by a command, when it has one.
pub fn command_active_session_id(command: &DaemonCommand) -> Option<&str> {
    match command {
        DaemonCommand::GetDirectWorkerTransport {
            active_session_id, ..
        }
        | DaemonCommand::Attach {
            active_session_id, ..
        }
        | DaemonCommand::Reattach {
            active_session_id, ..
        }
        | DaemonCommand::CompleteOwnedSession {
            active_session_id, ..
        }
        | DaemonCommand::PromoteOwnedSession {
            active_session_id, ..
        }
        | DaemonCommand::Kill {
            active_session_id, ..
        }
        | DaemonCommand::Rename {
            active_session_id, ..
        }
        | DaemonCommand::Prompt {
            active_session_id, ..
        }
        | DaemonCommand::CancelPromptAdmission {
            active_session_id, ..
        }
        | DaemonCommand::PromptAndWait {
            active_session_id, ..
        }
        | DaemonCommand::Steer {
            active_session_id, ..
        }
        | DaemonCommand::FollowUp {
            active_session_id, ..
        }
        | DaemonCommand::RestoreNextTurn {
            active_session_id, ..
        }
        | DaemonCommand::RestoreActions {
            active_session_id, ..
        }
        | DaemonCommand::AppendCustomMessage {
            active_session_id, ..
        }
        | DaemonCommand::ResumeQueue {
            active_session_id, ..
        }
        | DaemonCommand::AgentMessagesClear {
            active_session_id, ..
        }
        | DaemonCommand::Abort {
            active_session_id, ..
        }
        | DaemonCommand::StartSideQuestion {
            active_session_id, ..
        }
        | DaemonCommand::AbortSideQuestion {
            active_session_id, ..
        }
        | DaemonCommand::ExecuteBash {
            active_session_id, ..
        }
        | DaemonCommand::AbortBash {
            active_session_id, ..
        }
        | DaemonCommand::CancelRlmChild {
            active_session_id, ..
        }
        | DaemonCommand::DeleteRlmSubagent {
            active_session_id, ..
        }
        | DaemonCommand::WaitForIdle {
            active_session_id, ..
        }
        | DaemonCommand::WaitForHeadlessCompletion {
            active_session_id, ..
        }
        | DaemonCommand::GetSessionHeader {
            active_session_id, ..
        }
        | DaemonCommand::GetState {
            active_session_id, ..
        }
        | DaemonCommand::GetConnectionState {
            active_session_id, ..
        }
        | DaemonCommand::GetMessages {
            active_session_id, ..
        }
        | DaemonCommand::GetRlmChildren {
            active_session_id, ..
        }
        | DaemonCommand::GetSessionStats {
            active_session_id, ..
        }
        | DaemonCommand::GetContextTree {
            active_session_id, ..
        }
        | DaemonCommand::GetCommands {
            active_session_id, ..
        }
        | DaemonCommand::GetResourceSnapshot {
            active_session_id, ..
        }
        | DaemonCommand::GetMcpConnections {
            active_session_id, ..
        }
        | DaemonCommand::SetMcpStaticToken {
            active_session_id, ..
        }
        | DaemonCommand::RemoveMcpConnection {
            active_session_id, ..
        }
        | DaemonCommand::ReplaceAcpMcpServers {
            active_session_id, ..
        }
        | DaemonCommand::GetModelCatalog {
            active_session_id, ..
        }
        | DaemonCommand::GetAvailableModels {
            active_session_id, ..
        }
        | DaemonCommand::GetQueue {
            active_session_id, ..
        }
        | DaemonCommand::MutateQueuedMessage {
            active_session_id, ..
        }
        | DaemonCommand::ClearQueue {
            active_session_id, ..
        }
        | DaemonCommand::AbortAndClearQueue {
            active_session_id, ..
        }
        | DaemonCommand::AcquireSessionInputPause {
            active_session_id, ..
        }
        | DaemonCommand::ReleaseSessionInputPause {
            active_session_id, ..
        }
        | DaemonCommand::HeartbeatManage {
            active_session_id, ..
        }
        | DaemonCommand::CronAdd {
            active_session_id, ..
        }
        | DaemonCommand::HeartbeatGet {
            active_session_id, ..
        }
        | DaemonCommand::HeartbeatSet {
            active_session_id, ..
        }
        | DaemonCommand::HeartbeatUpdate {
            active_session_id, ..
        }
        | DaemonCommand::SetModel {
            active_session_id, ..
        }
        | DaemonCommand::CycleModel {
            active_session_id, ..
        }
        | DaemonCommand::SetScopedModels {
            active_session_id, ..
        }
        | DaemonCommand::SetThinkingLevel {
            active_session_id, ..
        }
        | DaemonCommand::SetServiceTier {
            active_session_id, ..
        }
        | DaemonCommand::CycleThinkingLevel {
            active_session_id, ..
        }
        | DaemonCommand::SetTransport {
            active_session_id, ..
        }
        | DaemonCommand::SetSteeringMode {
            active_session_id, ..
        }
        | DaemonCommand::SetFollowUpMode {
            active_session_id, ..
        }
        | DaemonCommand::SetAutoCompaction {
            active_session_id, ..
        }
        | DaemonCommand::SetAutoRetry {
            active_session_id, ..
        }
        | DaemonCommand::Compact {
            active_session_id, ..
        }
        | DaemonCommand::Refine {
            active_session_id, ..
        }
        | DaemonCommand::AbortCompaction {
            active_session_id, ..
        }
        | DaemonCommand::AbortBranchSummary {
            active_session_id, ..
        }
        | DaemonCommand::AbortRetry {
            active_session_id, ..
        }
        | DaemonCommand::ExecuteBashAndWait {
            active_session_id, ..
        }
        | DaemonCommand::Reload {
            active_session_id, ..
        }
        | DaemonCommand::NewSession {
            active_session_id, ..
        }
        | DaemonCommand::SwitchSession {
            active_session_id, ..
        }
        | DaemonCommand::Fork {
            active_session_id, ..
        }
        | DaemonCommand::NavigateTree {
            active_session_id, ..
        }
        | DaemonCommand::ImportJsonl {
            active_session_id, ..
        }
        | DaemonCommand::ExportHtml {
            active_session_id, ..
        }
        | DaemonCommand::ExportJsonl {
            active_session_id, ..
        }
        | DaemonCommand::SetSessionName {
            active_session_id, ..
        }
        | DaemonCommand::GetRlmMaxDepthStatus {
            active_session_id, ..
        }
        | DaemonCommand::SetRlmMaxDepth {
            active_session_id, ..
        }
        | DaemonCommand::GetSessionContext {
            active_session_id, ..
        }
        | DaemonCommand::GetSessionTree {
            active_session_id, ..
        }
        | DaemonCommand::GetUserMessagesForForking {
            active_session_id, ..
        }
        | DaemonCommand::GetLastAssistantText {
            active_session_id, ..
        }
        | DaemonCommand::GetSystemPrompt {
            active_session_id, ..
        }
        | DaemonCommand::GetToolDefinition {
            active_session_id, ..
        }
        | DaemonCommand::SetSessionEntryLabel {
            active_session_id, ..
        }
        | DaemonCommand::ExtensionUiResponse {
            active_session_id, ..
        }
        | DaemonCommand::RetryWorker {
            active_session_id, ..
        }
        | DaemonCommand::WorkerRegister {
            active_session_id, ..
        } => Some(active_session_id),
        DaemonCommand::ListSavedSessions {
            active_session_id, ..
        } => active_session_id.as_deref(),
        DaemonCommand::Detach {
            active_session_id, ..
        } => active_session_id.as_deref(),
        DaemonCommand::AgentMessagesStatus {
            active_session_id, ..
        } => active_session_id.as_deref(),
        DaemonCommand::AgentMessagesPause {
            active_session_id, ..
        } => active_session_id.as_deref(),
        DaemonCommand::AgentMessagesResume {
            active_session_id, ..
        } => active_session_id.as_deref(),
        DaemonCommand::CronList {
            active_session_id, ..
        } => active_session_id.as_deref(),
        DaemonCommand::HeartbeatsList {
            active_session_id, ..
        } => active_session_id.as_deref(),
        DaemonCommand::CronCancel {
            active_session_id, ..
        } => active_session_id.as_deref(),
        DaemonCommand::RenameSavedSession {
            active_session_id, ..
        } => active_session_id.as_deref(),
        DaemonCommand::DeleteSavedSession {
            active_session_id, ..
        } => active_session_id.as_deref(),
        // Control-plane commands carry no session selector.
        DaemonCommand::List { .. }
        | DaemonCommand::ListAgentPeers { .. }
        | DaemonCommand::GetWorkerPeerTransport { .. }
        | DaemonCommand::RosterSubscribe { .. }
        | DaemonCommand::WorkerRosterDelta { .. }
        | DaemonCommand::RosterUnsubscribe { .. }
        | DaemonCommand::Create { .. }
        | DaemonCommand::SendMessage { .. }
        | DaemonCommand::AckResult { .. }
        | DaemonCommand::PrepareUpdateRestart { .. }
        | DaemonCommand::CommitUpdateRestart { .. }
        | DaemonCommand::UpdateRestoreStatus { .. }
        | DaemonCommand::Restart { .. }
        | DaemonCommand::Shutdown { .. } => None,
    }
}

pub fn command_type_name(command: &DaemonCommand) -> &'static str {
    match command {
        DaemonCommand::List { .. } => "list",
        DaemonCommand::ListSavedSessions { .. } => "list_saved_sessions",
        DaemonCommand::ListAgentPeers { .. } => "list_agent_peers",
        DaemonCommand::GetDirectWorkerTransport { .. } => "get_direct_worker_transport",
        DaemonCommand::GetWorkerPeerTransport { .. } => "get_worker_peer_transport",
        DaemonCommand::RosterSubscribe { .. } => "roster_subscribe",
        DaemonCommand::WorkerRosterDelta { .. } => "worker_roster_delta",
        DaemonCommand::RosterUnsubscribe { .. } => "roster_unsubscribe",
        DaemonCommand::Create { .. } => "create",
        DaemonCommand::Attach { .. } => "attach",
        DaemonCommand::Reattach { .. } => "reattach",
        DaemonCommand::Detach { .. } => "detach",
        DaemonCommand::CompleteOwnedSession { .. } => "complete_owned_session",
        DaemonCommand::PromoteOwnedSession { .. } => "promote_owned_session",
        DaemonCommand::Kill { .. } => "kill",
        DaemonCommand::Rename { .. } => "rename",
        DaemonCommand::Prompt { .. } => "prompt",
        DaemonCommand::CancelPromptAdmission { .. } => "cancel_prompt_admission",
        DaemonCommand::PromptAndWait { .. } => "prompt_and_wait",
        DaemonCommand::Steer { .. } => "steer",
        DaemonCommand::FollowUp { .. } => "follow_up",
        DaemonCommand::RestoreNextTurn { .. } => "restore_next_turn",
        DaemonCommand::RestoreActions { .. } => "restore_actions",
        DaemonCommand::AppendCustomMessage { .. } => "append_custom_message",
        DaemonCommand::ResumeQueue { .. } => "resume_queue",
        DaemonCommand::SendMessage { .. } => "send_message",
        DaemonCommand::AgentMessagesStatus { .. } => "agent_messages_status",
        DaemonCommand::AgentMessagesPause { .. } => "agent_messages_pause",
        DaemonCommand::AgentMessagesResume { .. } => "agent_messages_resume",
        DaemonCommand::AgentMessagesClear { .. } => "agent_messages_clear",
        DaemonCommand::Abort { .. } => "abort",
        DaemonCommand::StartSideQuestion { .. } => "start_side_question",
        DaemonCommand::AbortSideQuestion { .. } => "abort_side_question",
        DaemonCommand::ExecuteBash { .. } => "execute_bash",
        DaemonCommand::AbortBash { .. } => "abort_bash",
        DaemonCommand::CancelRlmChild { .. } => "cancel_rlm_child",
        DaemonCommand::DeleteRlmSubagent { .. } => "delete_rlm_subagent",
        DaemonCommand::WaitForIdle { .. } => "wait_for_idle",
        DaemonCommand::WaitForHeadlessCompletion { .. } => "wait_for_headless_completion",
        DaemonCommand::GetSessionHeader { .. } => "get_session_header",
        DaemonCommand::GetState { .. } => "get_state",
        DaemonCommand::GetConnectionState { .. } => "get_connection_state",
        DaemonCommand::GetMessages { .. } => "get_messages",
        DaemonCommand::GetRlmChildren { .. } => "get_rlm_children",
        DaemonCommand::GetSessionStats { .. } => "get_session_stats",
        DaemonCommand::GetContextTree { .. } => "get_context_tree",
        DaemonCommand::GetCommands { .. } => "get_commands",
        DaemonCommand::GetResourceSnapshot { .. } => "get_resource_snapshot",
        DaemonCommand::GetMcpConnections { .. } => "get_mcp_connections",
        DaemonCommand::SetMcpStaticToken { .. } => "set_mcp_static_token",
        DaemonCommand::RemoveMcpConnection { .. } => "remove_mcp_connection",
        DaemonCommand::ReplaceAcpMcpServers { .. } => "replace_acp_mcp_servers",
        DaemonCommand::GetModelCatalog { .. } => "get_model_catalog",
        DaemonCommand::GetAvailableModels { .. } => "get_available_models",
        DaemonCommand::GetQueue { .. } => "get_queue",
        DaemonCommand::MutateQueuedMessage { .. } => "mutate_queued_message",
        DaemonCommand::ClearQueue { .. } => "clear_queue",
        DaemonCommand::AbortAndClearQueue { .. } => "abort_and_clear_queue",
        DaemonCommand::AcquireSessionInputPause { .. } => "acquire_session_input_pause",
        DaemonCommand::ReleaseSessionInputPause { .. } => "release_session_input_pause",
        DaemonCommand::CronList { .. } => "cron_list",
        DaemonCommand::HeartbeatsList { .. } => "heartbeats_list",
        DaemonCommand::HeartbeatManage { .. } => "heartbeat_manage",
        DaemonCommand::CronAdd { .. } => "cron_add",
        DaemonCommand::CronCancel { .. } => "cron_cancel",
        DaemonCommand::HeartbeatGet { .. } => "heartbeat_get",
        DaemonCommand::HeartbeatSet { .. } => "heartbeat_set",
        DaemonCommand::HeartbeatUpdate { .. } => "heartbeat_update",
        DaemonCommand::SetModel { .. } => "set_model",
        DaemonCommand::CycleModel { .. } => "cycle_model",
        DaemonCommand::SetScopedModels { .. } => "set_scoped_models",
        DaemonCommand::SetThinkingLevel { .. } => "set_thinking_level",
        DaemonCommand::SetServiceTier { .. } => "set_service_tier",
        DaemonCommand::CycleThinkingLevel { .. } => "cycle_thinking_level",
        DaemonCommand::SetTransport { .. } => "set_transport",
        DaemonCommand::SetSteeringMode { .. } => "set_steering_mode",
        DaemonCommand::SetFollowUpMode { .. } => "set_follow_up_mode",
        DaemonCommand::SetAutoCompaction { .. } => "set_auto_compaction",
        DaemonCommand::SetAutoRetry { .. } => "set_auto_retry",
        DaemonCommand::Compact { .. } => "compact",
        DaemonCommand::Refine { .. } => "refine",
        DaemonCommand::AbortCompaction { .. } => "abort_compaction",
        DaemonCommand::AbortBranchSummary { .. } => "abort_branch_summary",
        DaemonCommand::AbortRetry { .. } => "abort_retry",
        DaemonCommand::ExecuteBashAndWait { .. } => "execute_bash_and_wait",
        DaemonCommand::Reload { .. } => "reload",
        DaemonCommand::NewSession { .. } => "new_session",
        DaemonCommand::SwitchSession { .. } => "switch_session",
        DaemonCommand::Fork { .. } => "fork",
        DaemonCommand::NavigateTree { .. } => "navigate_tree",
        DaemonCommand::ImportJsonl { .. } => "import_jsonl",
        DaemonCommand::ExportHtml { .. } => "export_html",
        DaemonCommand::ExportJsonl { .. } => "export_jsonl",
        DaemonCommand::SetSessionName { .. } => "set_session_name",
        DaemonCommand::GetRlmMaxDepthStatus { .. } => "get_rlm_max_depth_status",
        DaemonCommand::SetRlmMaxDepth { .. } => "set_rlm_max_depth",
        DaemonCommand::RenameSavedSession { .. } => "rename_saved_session",
        DaemonCommand::DeleteSavedSession { .. } => "delete_saved_session",
        DaemonCommand::GetSessionContext { .. } => "get_session_context",
        DaemonCommand::GetSessionTree { .. } => "get_session_tree",
        DaemonCommand::GetUserMessagesForForking { .. } => "get_user_messages_for_forking",
        DaemonCommand::GetLastAssistantText { .. } => "get_last_assistant_text",
        DaemonCommand::GetSystemPrompt { .. } => "get_system_prompt",
        DaemonCommand::GetToolDefinition { .. } => "get_tool_definition",
        DaemonCommand::SetSessionEntryLabel { .. } => "set_session_entry_label",
        DaemonCommand::ExtensionUiResponse { .. } => "extension_ui_response",
        DaemonCommand::AckResult { .. } => "ack_result",
        DaemonCommand::PrepareUpdateRestart { .. } => "prepare_update_restart",
        DaemonCommand::CommitUpdateRestart { .. } => "commit_update_restart",
        DaemonCommand::RetryWorker { .. } => "retry_worker",
        DaemonCommand::UpdateRestoreStatus { .. } => "update_restore_status",
        DaemonCommand::Restart { .. } => "restart",
        DaemonCommand::Shutdown { .. } => "shutdown",
        DaemonCommand::WorkerRegister { .. } => "worker_register",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn envelope_round_trips() {
        let line = r#"{"type":"command","id":"c1","protocol":{"name":"prime-agent.daemon","version":7},"command":{"type":"list","all":true}}"#;
        let envelope = parse_daemon_command_line(line).expect("envelope parses");
        assert_eq!(envelope.id, "c1");
        assert!(matches!(envelope.command, DaemonCommand::List { .. }));
    }

    #[test]
    fn unknown_command_is_preserved() {
        let line = r#"{"type":"command","id":"c2","protocol":{"name":"prime-agent.daemon","version":7},"command":{"type":"bogus_command","activeSessionId":"x"}}"#;
        let err = parse_daemon_command_line(line).unwrap_err();
        assert_eq!(err.to_string(), "Unknown daemon command: bogus_command");
    }

    #[test]
    fn old_protocol_is_rejected() {
        let line = r#"{"type":"command","id":"c3","protocol":{"name":"prime-agent.daemon","version":6},"command":{"type":"list"}}"#;
        let err = parse_daemon_command_line(line).unwrap_err();
        assert!(err.to_string().contains("protocol 7 or newer"));
    }

    #[test]
    fn replay_info_matches_ts() {
        let info = create_daemon_replay_info(None, 5, "legacy");
        assert_eq!(info.status, DaemonReplayStatus::Complete);
        let info = create_daemon_replay_info(
            Some(&DaemonResumeCursor {
                active_session_id: None,
                generation: Some("other".to_string()),
                sequence: Some(2),
                event_sequence: None,
            }),
            5,
            "legacy",
        );
        assert_eq!(info.reason.as_deref(), Some("event_generation_changed"));
        let info = create_daemon_replay_info(
            Some(&DaemonResumeCursor {
                active_session_id: None,
                generation: None,
                sequence: None,
                event_sequence: Some(9),
            }),
            5,
            "legacy",
        );
        assert_eq!(
            info.reason.as_deref(),
            Some("resume_cursor_ahead_of_session")
        );
    }

    /// The standalone response line byte-orders its keys exactly like the
    /// TS daemon wire bytes (`daemon-protocol.ts` `success`/`failure`):
    /// id?, type, command, success, then data or error/errorInfo.
    #[test]
    fn response_line_serializes_in_the_ts_key_order() {
        let success = response_success(Some("k1"), "compact", Some(json!({"x": 1})));
        assert_eq!(
            serde_json::to_string(&response_line(&success)).unwrap(),
            "{\"id\":\"k1\",\"type\":\"response\",\"command\":\"compact\",\"success\":true,\"data\":{\"x\":1}}"
        );
        let failure = response_failure(Some("k2"), "compact", "boom", None);
        assert_eq!(
            serde_json::to_string(&response_line(&failure)).unwrap(),
            "{\"id\":\"k2\",\"type\":\"response\",\"command\":\"compact\",\"success\":false,\"error\":\"boom\"}"
        );
    }
}
