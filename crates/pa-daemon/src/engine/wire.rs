//! The engine wire types: the prompt records, the event stream shape, the
//! goal-continuation + bash-notice plumbing, the RLM session identity, and
//! the compaction/branch-summary/side-question records.
use super::{json, json_round_trip, Arc, SideQuestionTurn, Value};

/// One user prompt accepted by the engine.
#[derive(Debug, Clone)]
pub struct PromptRequest {
    pub message: String,
    /// Images attached to the prompt (base64 payload plus mime type),
    /// admitted as multimodal content after the text block.
    pub images: Vec<pa_agent::types::ImageContent>,
    pub source: String,
    pub agent_message_id: Option<String>,
    /// An injected custom row (wire `role: "custom"`) that replaces the
    /// accepted user message for this turn: the row persists and renders,
    /// the model runs on `message`.
    pub custom_message: Option<Value>,
    /// Co-delivered user rows of a batched turn: each row is accepted
    /// (persisted and rendered) in order ahead of the model turn, and the
    /// loop context carries every row as one `agent.prompt` message list.
    pub batch: Vec<PromptBatchRow>,
}

/// One co-delivered user row of a batched prompt request.
#[derive(Debug, Clone)]
pub struct PromptBatchRow {
    pub text: String,
    pub images: Vec<pa_agent::types::ImageContent>,
}

/// The saved session context read off a session's already-loaded entries:
/// the `(provider, model)` the file pins, and the thinking level only
/// when the file carries a `thinking_level_change` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedSessionContext {
    pub(crate) model: Option<(String, String)>,
    pub(crate) thinking: Option<pa_types::ai::ModelThinkingLevel>,
}

/// Explicit model selection from a session's create config (the wire
/// `provider`/`model`/`apiKey`/`thinking` fields). `None` fields keep the
/// engine's current selection.
#[derive(Debug, Clone, Default)]
pub struct EngineModelSelection {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
    /// The requested thinking level (`--thinking` on the wire). The engine
    /// resolves the effective level against the model's supported levels.
    pub thinking: Option<pa_types::ai::ModelThinkingLevel>,
}

/// Events an engine emits for one prompt, in order. The worker translates these
/// into protocol events and session-store writes. Returning `false` from the
/// emit callback cancels the prompt.
#[derive(Debug, Clone, PartialEq)]
pub enum EngineEvent {
    /// The user message that was accepted (recorded into the session store).
    UserMessage(Value),
    /// An assistant message update (streaming): the loop's shared
    /// [`AssistantSnapshot`] plus the provider stream event that produced it.
    AssistantUpdate {
        message: AssistantSnapshot,
        stream_event: Option<Value>,
    },
    /// The final assistant message (recorded into the session store).
    AssistantMessage(Value),
    ToolExecutionStart {
        tool_call_id: String,
        tool_name: String,
        args: Value,
    },
    ToolExecutionUpdate {
        tool_call_id: String,
        partial_result: Value,
    },
    /// A tool call finished; `is_error` mirrors the tool result.
    ToolExecutionEnd {
        tool_call_id: String,
        result: Value,
        is_error: bool,
    },
    /// A tool-result message (wire `role: "toolResult"`): recorded into the
    /// session store, framed to clients as a `message_start` + `message_end` pair.
    ToolResultMessage(Value),
    /// A turn of the model loop started: emitted for every turn after the
    /// first — the worker's own run-opening `turn_start` is the first turn's.
    TurnStart,
    /// A turn of the model loop ended: the terminal assistant message plus
    /// the turn's tool-result messages, in the session wire shapes; emitted
    /// for every settled turn, aborts and provider errors included.
    TurnEnd {
        message: Value,
        tool_results: Vec<Value>,
    },
    /// An agent run started, one per run (retries included): the engine
    /// forwards only the later runs' (the worker's frame opens the first run).
    AgentStart,
    /// An agent run ended (TS wire `agent_end`): the run's whole message
    /// set in the session wire shapes — the prompt rows (the harness digest
    /// and the user row), every assistant row, the tool results, and every
    /// steering/follow-up/continuation row drained within the run. Emitted
    /// per agent run, aborts and provider errors included (the messages
    /// carry the aborted/error row), like the TS session's loop-event
    /// forwarding. The rows themselves persist and broadcast through
    /// their own events; this frame carries only the accumulated payload.
    AgentEnd {
        messages: Vec<Value>,
    },
    /// A durable custom message (wire `role: "custom"`): recorded into the
    /// session store, framed to clients as a `message_start` + `message_end` pair.
    CustomMessage(Value),
    /// A compaction run started (TS `compaction_start` wire event); the
    /// payload is the complete event. Emitted before the summarizer runs so
    /// attached clients can swap their loader to the compaction label.
    CompactionStart {
        event: Value,
    },
    /// A compaction settled (TS `compaction_end` wire event): `entry` is the
    /// `compaction` record to persist (null when the run skipped or
    /// failed), `event` the complete client-facing event (result on
    /// success, errorMessage with its severity otherwise).
    Compaction {
        entry: Value,
        event: Value,
    },
    /// The prompt completed (successfully or not).
    Done(std::result::Result<(), String>),
    /// The prompt settled as aborted: like `Done(Err(..))`, except an
    /// aborted run is not a provider failure (spoofable text).
    DoneAborted,
    /// `goal_update`: the session goal state changed (TS wire event; the
    /// ACP adapter surfaces it as the namespaced `_meta.goal` update).
    /// The payload is the TS `GoalState` wire object.
    GoalUpdate {
        goal: Value,
    },
    /// `auto_retry_start`: a provider failure is being retried (TS wire
    /// event; the interactive transcript shows the retry countdown). A
    /// `Backup` reason is a provider-failover switch: the failed turn
    /// re-routes to another configured provider serving the same model and
    /// re-issues immediately.
    AutoRetryStart {
        attempt: u32,
        max_attempts: u32,
        delay_ms: u64,
        error_message: String,
        reason: pa_core::session_engine::auto_retry::RetryStartReason,
    },
    /// `auto_retry_end`: the retry loop settled. `restored_model` is the
    /// `"provider/model-id"` primary restored after a failover switch.
    AutoRetryEnd {
        success: bool,
        attempt: u32,
        final_error: Option<String>,
        restored_model: Option<String>,
    },
    RefineComplete {
        result: Value,
    },
    RefineFailed {
        error: String,
    },
}

/// A streamed assistant message: already in wire form, or the loop's typed
/// partial, converted only when a frame is built.
#[derive(Debug, Clone, PartialEq)]
pub enum AssistantSnapshot {
    Wire(Value),
    Loop(Arc<pa_agent::types::AgentMessage>),
}

impl AssistantSnapshot {
    pub(crate) fn into_wire(self) -> Option<Value> {
        match self {
            Self::Wire(value) => Some(value),
            Self::Loop(message) => session_wire_value(&message),
        }
    }
}

/// Serialize a pa-agent message through the session wire shape (adds `role`).
pub(crate) fn session_wire_value(agent_message: &pa_agent::types::AgentMessage) -> Option<Value> {
    use pa_agent::types::Message as LoopMessage;
    let session_message = match agent_message {
        pa_agent::types::AgentMessage::Standard(LoopMessage::User(user)) => {
            pa_types::session::AgentMessage::User(json_round_trip(user)?)
        }
        pa_agent::types::AgentMessage::Standard(LoopMessage::Assistant(assistant)) => {
            pa_types::session::AgentMessage::Assistant(json_round_trip(assistant)?)
        }
        pa_agent::types::AgentMessage::Standard(LoopMessage::ToolResult(tool_result)) => {
            pa_types::session::AgentMessage::ToolResult(json_round_trip(tool_result)?)
        }
        // A custom row: the payload is the session-shape custom message and
        // the wire form is the tagged session message (payload plus role).
        pa_agent::types::AgentMessage::Custom(custom) => {
            let mut value = custom.payload.clone();
            let object = value.as_object_mut()?;
            object
                .entry("role".to_string())
                .or_insert_with(|| Value::String(custom.role.clone()));
            return Some(value);
        }
    };
    serde_json::to_value(&session_message).ok()
}

/// The post-compaction goal continuation: the follow-up turn to admit
/// (continuation text + goal-context custom row) plus its `goal_update`.
#[derive(Debug, Clone)]
pub struct GoalContinuation {
    /// The continuation turn request: the normalized continuation text,
    /// the goal-context custom message, `resumeIfIdle: true`.
    pub request: PromptRequest,
    /// The `goal_update` event's `goal` payload, `None` when an
    /// unchanged state stays silent.
    pub goal_update: Option<Value>,
    /// This mint's own pending-continuation guard handle: releases name
    /// exactly the mint's guard, never the mutable mirror.
    pub pending_handle: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
}

/// The goal-driven work a settled run boundary owes. Each variant
/// carries the minted turn as a [`GoalContinuation`].
#[derive(Debug, Clone)]
pub enum GoalTurnEndWork {
    /// The token budget was crossed this run: the budget-limit wrap-up
    /// steer, queued with `resumeIfIdle: true`.
    BudgetLimitSteer(GoalContinuation),
    /// The continuation context turn for an active goal (the follow-up lane).
    Continuation(GoalContinuation),
}

/// The worker's session-input probe: `true` while queued user work or a
/// held suspension owns the next turn boundary, so the goal mint defers.
pub type SessionInputProbe = std::sync::Arc<dyn Fn() -> bool + Send + Sync>;

/// One detached kernel bash completion (the `bash.completed` host
/// request): the finished command's identity and exit code.
#[derive(Debug, Clone)]
pub struct BashCompletionNotice {
    pub pid: u32,
    pub command: String,
    pub exit_code: i64,
}

/// The queue-admission seam for one completion notice (the worker's
/// steering lane + runner wake + recovery busy-evidence).
pub type BashCompletionSink = std::sync::Arc<dyn Fn(BashCompletionNotice) + Send + Sync>;

/// The kernel read a finished command's result before its notice
/// delivered (the `bash.consumed` host request): the queued notice is stale.
#[derive(Debug, Clone)]
pub struct BashConsumedNotice {
    pub pid: u32,
    pub command: String,
}

/// The queue-withdrawal seam for a consumed notice.
pub type BashConsumedSink = std::sync::Arc<dyn Fn(BashConsumedNotice) + Send + Sync>;

/// The worker's goal admission sink: the queue lanes admit a minted goal
/// follow-up, the `goal_update` surfaces, and the runner wakes.
pub type GoalAdmissionSink = std::sync::Arc<dyn Fn(GoalTurnEndWork) + Send + Sync>;

/// RLM recursion identity carried by a session's create command: depth,
/// bound, cwd, persistence ids, and the children's default thinking level.
#[derive(Debug, Clone, Default)]
pub struct RlmSessionIdentity {
    pub rlm_depth: u32,
    pub rlm_max_depth: Option<u32>,
    pub cwd: Option<String>,
    pub session_id: Option<String>,
    pub session_file: Option<String>,
    pub thinking: Option<String>,
    /// Verification seam: children of this session spawn with a scripted
    /// engine file. Product sessions carry `None`.
    pub child_script: Option<String>,
    /// The session's semantic-edge spawn origin (TS
    /// `semanticParentSessionId` + `semanticSpawnedByRequestId`, carried
    /// by a subagent create): `Some` only for a create whose runtime
    /// metadata declares `kind: "subagent"` — a resumed saved subagent
    /// file is a top-level runtime and spawns no edge, and a replacement
    /// runtime has none.
    pub semantic_spawn: Option<SemanticSpawnOrigin>,
}

/// A created session's semantic-edge provenance (TS
/// `semanticParentSessionId`/`semanticSpawnedByRequestId`): the parent's
/// durable session id and the request whose turn spawned this child.
#[derive(Debug, Clone)]
pub struct SemanticSpawnOrigin {
    pub parent_session_id: Option<String>,
    pub spawned_by_request_id: Option<String>,
}

/// The resource snapshot for a session without a resource surface (the TS
/// loader shape over empty lists): every category present, every list
/// empty.
#[must_use]
pub fn empty_resource_snapshot() -> Value {
    json!({
        "contextFiles": [],
        "skills": [],
        "prompts": [],
        "themes": [],
        "diagnostics": {
            "skills": [],
            "prompts": [],
            "themes": [],
        },
    })
}

/// One compaction request (the `compact` command fields).
#[derive(Debug, Clone)]
pub struct CompactionRequest {
    /// `/compact <instructions>` guidance for the summary.
    pub custom_instructions: Option<String>,
}

/// The completed compaction: the wire `CompactionResult` plus the
/// summarizer usage (persisted on the entry, never on the wire response).
#[derive(Debug, Clone, PartialEq)]
pub struct CompactionRun {
    /// TS `CompactionResult`: summary, firstKeptEntryId, tokensBefore,
    /// details.
    pub result: Value,
    /// Usage billed by the summarizer call(s), for the persisted entry.
    pub usage: Option<Value>,
    /// The full durable `compaction` record; null for scripted engines
    /// (a test seam with no real entry).
    pub entry: Value,
    /// The post-compaction `ipython_state` notice (`role: "custom"`) when
    /// the engine's kernel was running.
    pub ipython_state: Option<Value>,
}

/// How one compaction run ended (TS `compact` outcomes: result, skip,
/// "Compaction cancelled", or failure).
#[derive(Debug, Clone, PartialEq)]
pub enum CompactionOutcome {
    /// Compacted; the run carries the result and entry usage. Boxed:
    /// the run's insertion-ordered JSON maps (`preserve_order`, wire
    /// parity) would dwarf the other variants (`large_enum_variant`).
    Compacted { run: Box<CompactionRun> },
    /// Nothing to compact (TS `CompactionSkippedError`); the string is the
    /// user-facing skip message.
    Skipped { message: String },
    /// Aborted mid-run (`abort_compaction`).
    Aborted,
    /// Failed; the string is the engine error message.
    Failed { error: String },
}

/// One branch-summary request (`navigate_tree` with `summarize`): the
/// abandoned branch's durable entries (wire `FileEntry` form) and the
/// summarizer guidance from the client.
#[derive(Debug, Clone)]
pub struct BranchSummaryRequest {
    pub entries: Vec<pa_types::session::FileEntry>,
    pub custom_instructions: Option<String>,
    /// Replace the default prompt instead of appending the custom focus.
    pub replace_instructions: bool,
}

/// One completed branch summary: the final summary text, the summarizer
/// usage, and the file-operation details block persisted on the entry.
#[derive(Debug, Clone, PartialEq)]
pub struct BranchSummaryRun {
    pub summary: String,
    pub usage: Option<Value>,
    pub details: Option<Value>,
    /// The model that served the call (`provider`, `modelId`), persisted
    /// on the `branch_summary` entry for the per-model cost fold.
    pub model: Option<(String, String)>,
}

/// How one branch-summary run ended (TS `BranchSummaryResult` outcomes).
#[derive(Debug, Clone, PartialEq)]
pub enum BranchSummaryOutcome {
    /// Summary generated; the run carries text, usage, and details.
    Complete { run: BranchSummaryRun },
    /// Aborted mid-run (`abort_branch_summary`).
    Aborted,
    /// Failed; the string is the user-facing error.
    Failed { error: String },
}

/// One side-question request (the `start_side_question` command fields).
#[derive(Debug, Clone)]
pub struct SideQuestionRequest {
    /// Caller-generated id; echoed on every event of the run.
    pub side_question_id: String,
    pub question: String,
    /// Earlier `{question, answer}` exchanges replayed before the question.
    pub previous_turns: Vec<SideQuestionTurn>,
}

/// How one side-question run ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SideQuestionOutcome {
    /// Answered; the string is the final answer text.
    Complete { answer: String },
    /// Aborted mid-run; the string is the partial answer streamed so far.
    Aborted { answer: String },
    /// Failed; the string is the provider/engine error message.
    Failed { answer: String, error: String },
}

/// Wire form of one side-question status.
pub const SIDE_QUESTION_STATUS_RUNNING: &str = "running";
pub const SIDE_QUESTION_STATUS_COMPLETE: &str = "complete";
pub const SIDE_QUESTION_STATUS_CANCELLED: &str = "cancelled";
pub const SIDE_QUESTION_STATUS_ERROR: &str = "error";

/// Wire form of one side-question event.
#[must_use]
pub fn side_question_event_value(
    request: &SideQuestionRequest,
    answer: &str,
    status: &str,
    error_message: Option<&str>,
) -> Value {
    let mut event = json!({
        "id": request.side_question_id,
        "question": request.question,
        "answer": answer,
        "status": status,
    });
    if let Some(error_message) = error_message {
        event["errorMessage"] = json!(error_message);
    }
    event
}

impl SideQuestionOutcome {
    /// The wire status of this outcome.
    #[must_use]
    pub fn status_str(&self) -> &'static str {
        match self {
            SideQuestionOutcome::Complete { .. } => SIDE_QUESTION_STATUS_COMPLETE,
            SideQuestionOutcome::Aborted { .. } => SIDE_QUESTION_STATUS_CANCELLED,
            SideQuestionOutcome::Failed { .. } => SIDE_QUESTION_STATUS_ERROR,
        }
    }

    /// The answer text carried by the final event (partial on abort/failure).
    #[must_use]
    pub fn answer(&self) -> &str {
        match self {
            SideQuestionOutcome::Complete { answer }
            | SideQuestionOutcome::Aborted { answer }
            | SideQuestionOutcome::Failed { answer, .. } => answer,
        }
    }

    /// The error message carried by the final event, when the run failed.
    #[must_use]
    pub fn error_message(&self) -> Option<&str> {
        match self {
            SideQuestionOutcome::Failed { error, .. } => Some(error.as_str()),
            _ => None,
        }
    }
}
