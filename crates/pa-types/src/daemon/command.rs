//! Client commands: envelope, frame types, and the full `DaemonCommand` union.
//! Wire shapes match the TS daemon protocol exactly.

use super::*;

// ---------------------------------------------------------------------------
// Commands (client/worker -> supervisor/worker)
// ---------------------------------------------------------------------------

/// `type: "command"` envelope wrapping a [`DaemonCommand`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonCommandEnvelope {
    /// Fixed `"command"` frame tag.
    #[serde(rename = "type")]
    pub frame_type: DaemonCommandFrameType,
    pub id: DaemonCommandId,
    pub protocol: DaemonProtocolInfo,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<DaemonClientId>,
    pub command: DaemonCommand,
}

/// Frame tag of [`DaemonCommandEnvelope`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DaemonCommandFrameType {
    #[serde(rename = "command")]
    Command,
}

/// A bare command or a command envelope, both accepted on one socket line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DaemonCommandWire {
    Command(DaemonCommand),
    Envelope(DaemonCommandEnvelope),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamingBehavior {
    Steer,
    FollowUp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DaemonSessionLifecycle {
    Resident,
    ClientOwned,
}

/// `prompt`/`steer`/`follow_up`-family input payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub streaming_behavior: Option<StreamingBehavior>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_if_busy: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expand_prompt_templates: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_message: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix_messages: Option<Value>,
    /// Unique only when the caller needs cancellable pre-ownership admission.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admission_id: Option<String>,
}

/// Client commands, tagged by `type`. Every variant also carries `id` (when
/// sent as a bare command) and a catch-all for unknown fields, so wire
/// round-trips are lossless across schema revisions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum DaemonCommand {
    List {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        all: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_dir: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        include_client_owned: Option<bool>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    /// `list_saved_sessions` (session-addressed or cwd-addressed forms share
    /// this shape; unaddressed fields stay absent).
    ListSavedSessions {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        active_session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_dir: Option<String>,
        #[serde(default)]
        scope: Value,
        #[serde(flatten)]
        rest: JsonMap,
    },
    ListAgentPeers {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        /// The requester's worker token; optional on the wire (the TS
        /// supervisor arm reads an absent token as an authentication
        /// failure, not a parse one).
        #[serde(default)]
        worker_token: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    GetDirectWorkerTransport {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    /// Worker-to-worker peer ticket (thin-supervisor stage 3): a worker
    /// acting for its session asks the supervisor to mint a single-use
    /// `worker`-purpose grant for a target worker's direct socket so the
    /// delivery bypasses the supervisor's route plane. Authenticated by
    /// the requester's worker token, like `list_agent_peers`.
    GetWorkerPeerTransport {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        worker_token: String,
        target_active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    RosterSubscribe {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    /// Worker -> supervisor roster delta (the Rust-native form of the TS
    /// `roster_delta` worker frame): the worker pushes its slim session
    /// summary so the supervisor's roster tracks live status without
    /// polling. Authenticated by the worker token, like `worker_register`.
    WorkerRosterDelta {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        worker_token: String,
        summary: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        removed: Option<Vec<String>>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    RosterUnsubscribe {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    Create {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        continue_recent: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        no_session: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        config: Option<Value>,
        /// Telemetry opt-out (TS main.ts `telemetryDisabled`: only ever
        /// `Some(true)`; absent means enabled).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        telemetry_disabled: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        runtime_metadata: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lifecycle: Option<DaemonSessionLifecycle>,
        /// Allowlisted client env vars (`env`), carried on create only.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        env: Option<std::collections::BTreeMap<String, String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        launch_env: Option<std::collections::BTreeMap<String, String>>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    Attach {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        supports_extension_ui: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_id: Option<DaemonClientId>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        capabilities: Option<Vec<DaemonClientCapability>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resume_cursor: Option<DaemonResumeCursor>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        telemetry_disabled: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery_config: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        env: Option<std::collections::BTreeMap<String, String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        launch_env: Option<std::collections::BTreeMap<String, String>>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    Reattach {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        target_active_session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        supports_extension_ui: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        client_id: Option<DaemonClientId>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        capabilities: Option<Vec<DaemonClientCapability>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resume_cursor: Option<DaemonResumeCursor>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        telemetry_disabled: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery_config: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        env: Option<std::collections::BTreeMap<String, String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        launch_env: Option<std::collections::BTreeMap<String, String>>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    Detach {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        active_session_id: Option<String>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    CompleteOwnedSession {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    PromoteOwnedSession {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    Kill {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    Rename {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        name: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    Prompt {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        message: String,
        #[serde(flatten)]
        input: PromptInput,
        #[serde(flatten)]
        rest: JsonMap,
    },
    CancelPromptAdmission {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        admission_id: String,
        /// Cancel session-owned work too when it has not started delivery.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cancel_owned: Option<bool>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    PromptAndWait {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        message: String,
        #[serde(flatten)]
        input: PromptInput,
        #[serde(flatten)]
        rest: JsonMap,
    },
    Steer {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        message: String,
        #[serde(flatten)]
        input: PromptInput,
        #[serde(flatten)]
        rest: JsonMap,
    },
    FollowUp {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        message: String,
        #[serde(flatten)]
        input: PromptInput,
        #[serde(flatten)]
        rest: JsonMap,
    },
    RestoreNextTurn {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        messages: Vec<AgentMessage>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    RestoreActions {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        snapshot: Value,
        #[serde(flatten)]
        rest: JsonMap,
    },
    AppendCustomMessage {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        message: Value,
        #[serde(flatten)]
        rest: JsonMap,
    },
    ResumeQueue {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    SendMessage {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        target_active_session_id: String,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_active_session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_origin: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        delivery_mode: Option<Value>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    AgentMessagesStatus {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        active_session_id: Option<String>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    AgentMessagesPause {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        active_session_id: Option<String>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    AgentMessagesResume {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        active_session_id: Option<String>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    AgentMessagesClear {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    Abort {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    /// `abort_and_send_queued` (schema 29, capability-gated in TS): abort
    /// the active run and deliver the visible queued steering batch at the
    /// turn boundary; a plain abort when no steering is queued (TS
    /// `AgentSession.abortAndSendQueued`).
    AbortAndSendQueued {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    StartSideQuestion {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        // Optional on the wire (the TS runtime validates nothing at
        // parse; a routing miss answers before the payload is read).
        #[serde(default)]
        side_question_id: String,
        #[serde(default)]
        question: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        previous_turns: Option<Value>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    AbortSideQuestion {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        // Optional on the wire, like `start_side_question`'s payload.
        #[serde(default)]
        side_question_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    ExecuteBash {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exclude_from_context: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        transient: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        run_id: Option<String>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    AbortBash {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    /// Rust-native extension, advertised by the `kernel_bash_activity` capability.
    ListKernelBash {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    TailKernelBash {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        activity_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lines: Option<u32>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    KillKernelBash {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        activity_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    CancelRlmChild {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        child_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    DeleteRlmSubagent {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        child_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    WaitForIdle {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    WaitForHeadlessCompletion {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        wait_for_rlm_quiescence: Option<bool>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    GetSessionHeader {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    GetState {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    GetConnectionState {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    GetMessages {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    GetRlmChildren {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    GetSessionStats {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    GetContextTree {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    GetCommands {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    GetResourceSnapshot {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    GetMcpConnections {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    /// The inline paste flow: install a pasted static token for one
    /// pasteable catalog service (`server`), binding it to the service
    /// endpoint and verifying with a real MCP handshake.
    SetMcpStaticToken {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        server: String,
        token: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    /// Remove one MCP connection: its credential and its connection record
    /// (the durable endpoint pin), in one step.
    RemoveMcpConnection {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        server: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    ReplaceAcpMcpServers {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        owner_id: String,
        servers: Value,
        #[serde(flatten)]
        rest: JsonMap,
    },
    GetModelCatalog {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    GetAvailableModels {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    GetQueue {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    MutateQueuedMessage {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        lane: Value,
        index: u64,
        expected_text: String,
        mutation: Value,
        #[serde(flatten)]
        rest: JsonMap,
    },
    ClearQueue {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    AbortAndClearQueue {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    AcquireSessionInputPause {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        lease_key: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    ReleaseSessionInputPause {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        pause_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    CronList {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        active_session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        include_inactive: Option<bool>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    HeartbeatsList {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        active_session_id: Option<String>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    HeartbeatManage {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        job_id: String,
        action: Value,
        #[serde(flatten)]
        rest: JsonMap,
    },
    CronAdd {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        schedule: String,
        prompt: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        promote_owned_session: Option<bool>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    CronCancel {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        active_session_id: Option<String>,
        job_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    HeartbeatGet {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    HeartbeatSet {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        schedule: String,
        prompt: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        delivery_mode: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        promote_owned_session: Option<bool>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    HeartbeatUpdate {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        action: Value,
        #[serde(flatten)]
        rest: JsonMap,
    },
    SetModel {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        provider: String,
        model_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    CycleModel {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        direction: Option<CycleDirection>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    SetScopedModels {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        scoped_models: Value,
        #[serde(flatten)]
        rest: JsonMap,
    },
    SetThinkingLevel {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        // Optional on the wire (the TS runtime reads it after routing).
        #[serde(default)]
        level: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    SetServiceTier {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        service_tier: Option<crate::ai::ServiceTier>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    CycleThinkingLevel {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    SetTransport {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        transport: crate::ai::Transport,
        #[serde(flatten)]
        rest: JsonMap,
    },
    SetSteeringMode {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        mode: Value,
        #[serde(flatten)]
        rest: JsonMap,
    },
    SetFollowUpMode {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        mode: Value,
        #[serde(flatten)]
        rest: JsonMap,
    },
    SetAutoCompaction {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        enabled: bool,
        #[serde(flatten)]
        rest: JsonMap,
    },
    SetAutoRetry {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        enabled: bool,
        #[serde(flatten)]
        rest: JsonMap,
    },
    Compact {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        custom_instructions: Option<String>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    Refine {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        instructions: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rollback_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        global: Option<bool>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    AbortCompaction {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    AbortBranchSummary {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    AbortRetry {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    ExecuteBashAndWait {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        command: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    Reload {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    NewSession {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_session: Option<String>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    SwitchSession {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        session_path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd_override: Option<String>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    Fork {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        entry_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        position: Option<ForkPosition>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    NavigateTree {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        target_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summarize: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        custom_instructions: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        replace_instructions: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    ImportJsonl {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        input_path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd_override: Option<String>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    ExportHtml {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output_path: Option<String>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    ExportJsonl {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output_path: Option<String>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    SetSessionName {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        worker_token: Option<String>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    GetRlmMaxDepthStatus {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    SetRlmMaxDepth {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        max_depth: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        global: Option<bool>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    RenameSavedSession {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        active_session_id: Option<String>,
        session_path: String,
        name: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    DeleteSavedSession {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        active_session_id: Option<String>,
        session_path: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    GetSessionContext {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    GetSessionTree {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    GetUserMessagesForForking {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    GetLastAssistantText {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    GetSystemPrompt {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    GetToolDefinition {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        name: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    SetSessionEntryLabel {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        entry_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    ExtensionUiResponse {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        request_id: String,
        response: DaemonExtensionUiResponse,
        #[serde(flatten)]
        rest: JsonMap,
    },
    AckResult {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        command_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    /// Coordinator -> supervisor: start (or idempotently poll) the prepare
    /// transaction for `updateId`. The supervisor owns the deadline and the
    /// self-expiry marker; a repeated request with the same id returns the
    /// current state, a different id is refused.
    PrepareUpdateRestart {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        update_id: Option<String>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    /// Coordinator -> supervisor: consume the prepared transaction and stop
    /// gracefully (spec `docs/update-flow-state-machine.md` §5: the only
    /// consumption of the prepared artifact).
    CommitUpdateRestart {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        update_id: Option<String>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    RetryWorker {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(flatten)]
        rest: JsonMap,
    },
    /// Query the supervisor's boot-time restore pass (spec §6/§9): the
    /// successor reports whether the roster restore is in flight and the
    /// per-session counts/failures so the coordinator's `Restoring` phase
    /// reports real numbers (the adoption heuristic is gone). Read-only.
    UpdateRestoreStatus {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        update_id: Option<String>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    Restart {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    Shutdown {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        force: Option<bool>,
        #[serde(flatten)]
        rest: JsonMap,
    },
    /// Session-worker self-registration (worker -> supervisor). A booting
    /// worker presents its supervisor-issued identity so the supervisor can
    /// rebuild its roster; the same command re-registers the worker after a
    /// supervisor restart (the token was issued when the supervisor spawned
    /// or adopted the worker, so only the real worker can present it).
    WorkerRegister {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        active_session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        socket_path: String,
        worker_instance_id: String,
        token: String,
        pid: u64,
        #[serde(flatten)]
        rest: JsonMap,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CycleDirection {
    Forward,
    Backward,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ForkPosition {
    Before,
    At,
}

/// Response payload of an `extension_ui_request` dialog.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DaemonExtensionUiResponse {
    Value { value: String },
    Confirmed { confirmed: bool },
    Cancelled { cancelled: bool },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_family_roundtrip() {
        rt::<DaemonCommand>(
            r#"{"type":"steer","activeSessionId":"s1","message":"m","content":[{"type":"text","text":"x"}],"streamingBehavior":"steer","queueKey":"q","admissionId":"a1"}"#,
        );
        rt::<DaemonCommand>(
            r#"{"type":"cancel_prompt_admission","activeSessionId":"s1","admissionId":"a1","cancelOwned":true}"#,
        );
    }

    #[test]
    fn worker_register_roundtrip() {
        rt::<DaemonCommand>(
            r#"{"type":"worker_register","activeSessionId":"abc123def456","sessionId":"s-uuid","socketPath":"/tmp/w.sock","workerInstanceId":"inst-1","token":"tok","pid":4242}"#,
        );
    }

    #[test]
    fn extension_ui_response_variants() {
        rt::<DaemonExtensionUiResponse>(r#"{"value":"pick"}"#);
        rt::<DaemonExtensionUiResponse>(r#"{"confirmed":true}"#);
        rt::<DaemonExtensionUiResponse>(r#"{"cancelled":true}"#);
    }
}
