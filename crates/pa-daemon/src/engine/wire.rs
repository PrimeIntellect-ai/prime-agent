//! The engine wire types (moved with their concern): the prompt records,
//! the event stream shape, the goal-continuation + bash-notice plumbing,
//! the RLM session identity, and the compaction/branch-summary/
//! side-question records with their status consts.
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
    /// accepted user message for this turn: the turn persists and renders
    /// the custom row, then runs the model on `message` (TS injected-prompt
    /// turns: RLM child terminal notices).
    pub custom_message: Option<Value>,
    /// Co-delivered user rows of a batched turn (TS
    /// `_startPreparedTurnActions`): the queue's batched actions ride the
    /// same run as the primary message. Each row is accepted (persisted
    /// and rendered) in order ahead of the model turn, and the loop
    /// context carries every row as one `agent.prompt` message list.
    pub batch: Vec<PromptBatchRow>,
}

/// One co-delivered user row of a batched prompt request.
#[derive(Debug, Clone)]
pub struct PromptBatchRow {
    pub text: String,
    pub images: Vec<pa_agent::types::ImageContent>,
}

/// The saved session context TS `createAgentSession` reads off the session's
/// already-loaded entries (`sessionManager.buildSessionContext()` plus
/// `getBranch().some(...)` — sdk.ts): the `(provider, model)` the file pins
/// and the thinking level present only when the file carries a
/// `thinking_level_change` row (TS `hasThinkingEntry`). A caller that already
/// holds the opened store passes the pre-read context to
/// [`SessionEngine::restore_session_model`] so the restore never re-opens the
/// session file; `None` reads the file (the port's windowed fallback for
/// callers without an open store).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedSessionContext {
    pub(crate) model: Option<(String, String)>,
    pub(crate) thinking: Option<pa_types::ai::ModelThinkingLevel>,
}

/// Explicit model selection from a session's create config (the wire
/// `provider`/`model`/`apiKey`/`thinking` fields). `None` fields keep the
/// engine's current selection, mirroring the TS runtime-config merge
/// semantics.
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
    /// An assistant message update (streaming); the message is the loop's
    /// shared snapshot ([`AssistantSnapshot`]: wire form at frame build),
    /// plus the provider stream event that produced it (the TS wire
    /// carries `assistantMessageEvent` so clients can track activity).
    AssistantUpdate {
        message: AssistantSnapshot,
        stream_event: Option<Value>,
    },
    /// The final assistant message (recorded into the session store).
    AssistantMessage(Value),
    /// A tool call started executing.
    ToolExecutionStart {
        tool_call_id: String,
        tool_name: String,
        args: Value,
    },
    /// A tool produced a partial result while still executing.
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
    /// session store and framed to clients as a `message_start` +
    /// `message_end` pair, matching the TS session's loop-event forwarding.
    ToolResultMessage(Value),
    /// A turn of the model loop started (TS wire `turn_start`; the loop
    /// emits it for every turn after the first, so the worker's own
    /// run-opening `turn_start` stays the first turn's frame).
    TurnStart,
    /// A turn of the model loop ended (TS wire `turn_end`): the terminal
    /// assistant message plus the turn's tool-result messages, in the
    /// session wire shapes. Emitted for every settled turn — aborts and
    /// provider errors included (the aborted/error assistant row with
    /// empty tool results), like the TS session's loop-event forwarding.
    /// The rows themselves persist and broadcast through their own events;
    /// this frame carries only the terminal payload.
    TurnEnd {
        message: Value,
        tool_results: Vec<Value>,
    },
    /// An agent run started (TS wire `agent_start`). The loop emits one per
    /// agent run — retried and continued runs included — but the worker's
    /// own run-opening `agent_start` frame is the first run's, so the
    /// engine forwards only the later runs' frames (a boundary frame
    /// already passed in the item).
    AgentStart,
    /// An agent run ended (TS wire `agent_end`): the run's whole message
    /// set in the session wire shapes — the prompt rows (the harness digest
    /// and the user row), every assistant row, the tool results, and every
    /// steering/follow-up/continuation row drained within the run. Emitted
    /// per agent run, aborts and provider errors included (the messages
    /// carry the aborted/error row), like the TS session's loop-event
    /// forwarding. The rows themselves persist and broadcast through
    /// their own events; this frame carries only the accumulated payload.
    AgentEnd { messages: Vec<Value> },
    /// A durable custom message (wire `role: "custom"`): recorded into the
    /// session store and shown to attached clients. Emitted as a
    /// `message_start` + `message_end` pair, matching the TS session's
    /// `_emit` for custom rows.
    CustomMessage(Value),
    /// A compaction run started (TS `compaction_start` wire event); the
    /// payload is the complete event. Emitted before the summarizer runs so
    /// attached clients can swap their loader to the compaction label.
    CompactionStart { event: Value },
    /// A compaction settled (TS `compaction_end` wire event): `entry` is the
    /// `compaction` record to persist (null when the run skipped or
    /// failed), `event` the complete client-facing event (result on
    /// success, errorMessage with its severity otherwise).
    Compaction { entry: Value, event: Value },
    /// The prompt completed (successfully or not).
    Done(std::result::Result<(), String>),
    /// The prompt settled as aborted: the run was aborted before an
    /// assistant message was produced (a user abort or suspension).
    /// Every consumer treats it like `Done(Err(..))` — the wire frames
    /// carry the abort error — except the settle classification, which
    /// must not read the (spoofable) error text: an aborted run is not
    /// a provider failure (the scheduled-fire hook backs off on the
    /// one, not the other).
    DoneAborted,
    /// `goal_update`: the session goal state changed (TS wire event; the
    /// ACP adapter surfaces it as the namespaced `_meta.goal` update).
    /// The payload is the TS `GoalState` wire object.
    GoalUpdate { goal: Value },
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
    /// `"provider/model-id"` primary restored after a failover switch
    /// succeeded.
    AutoRetryEnd {
        success: bool,
        attempt: u32,
        final_error: Option<String>,
        restored_model: Option<String>,
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
        // A custom row (the harness digest, a goal-context row): the
        // payload is the session-shape custom message and the wire form is
        // the tagged session message — the payload plus the row's role
        // (TS `agent_end.messages` carries custom rows in this shape).
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

/// The post-compaction goal continuation (TS `compact()`'s `didCompact` +
/// active-goal branch: `resumeQueuedWork()` ->
/// `_maybeResumeGoalContinuationAfterRlmWork` mints the owed
/// continuation, and `_schedulePostCompactionContinue()` drives it): the
/// follow-up turn to admit — the continuation prompt text with the
/// durable goal-context row as the injected custom message — plus the
/// `goal_update` payload for the mint's state change when it moved the
/// engine's published baseline (TS `_setGoalState` -> `_emitGoalUpdate`).
#[derive(Debug, Clone)]
pub struct GoalContinuation {
    /// The continuation turn request (TS `_createPreparedTurnAction`
    /// "followUp": the normalized continuation text, the goal-context
    /// custom message, `resumeIfIdle: true`).
    pub request: PromptRequest,
    /// The `goal_update` event's `goal` payload, `None` when an
    /// unchanged state stays silent.
    pub goal_update: Option<Value>,
    /// This mint's own pending-continuation guard handle, captured under
    /// the driver lock at the mint: the admission and drop surfaces
    /// release exactly the mint's guard, never whichever handle the
    /// engine's mutable mirror currently holds (a stale task from before
    /// a core rebuild must not clear a replacement session's guard).
    /// `None` when the item armed no guard (the budget steer mints no
    /// continuation slot).
    pub pending_handle: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
}

/// The goal-driven work a settled run boundary owes: TS
/// `_shouldStopAfterTurn`'s budget arm and `_getGoalContinuationMessages`
/// at the agent loop's natural turn end. Each variant carries the minted
/// turn as a [`GoalContinuation`] (the request plus the `goal_update`
/// payload for the mint's state change).
#[derive(Debug, Clone)]
pub enum GoalTurnEndWork {
    /// The token budget was crossed this run: the budget-limit wrap-up
    /// steer (TS queues it on the steering schedule with
    /// `resumeIfIdle: true`, so the run ends and the steer drives the
    /// wrap-up turn).
    BudgetLimitSteer(GoalContinuation),
    /// The continuation context turn for an active goal (TS's queued
    /// `followUp` admission, the follow-up lane).
    Continuation(GoalContinuation),
}

/// The worker's session-input probe (TS `queuedActionCount > 0` plus the
/// queued-input suspension): `true` while queued user work or a held
/// suspension owns the next turn boundary, so the goal mint defers.
pub type SessionInputProbe = std::sync::Arc<dyn Fn() -> bool + Send + Sync>;

/// One detached kernel bash completion (the `bash.completed` host
/// request): the finished command's identity and exit code. The worker
/// queue admission turns it into the woken turn (TS
/// `createAsyncBashCompletionHostHandler` ->
/// `_promptInjectedMessage(..., { resumeIfIdle: true })`).
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
/// delivered (the `bash.consumed` host request): the queued notice is
/// stale and must withdraw (TS
/// `_withdrawAsyncBashCompletionNotice`).
#[derive(Debug, Clone)]
pub struct BashConsumedNotice {
    pub pid: u32,
    pub command: String,
}

/// The queue-withdrawal seam for a consumed notice.
pub type BashConsumedSink = std::sync::Arc<dyn Fn(BashConsumedNotice) + Send + Sync>;

/// The worker's goal admission sink: the turn runner's queue lanes admit
/// a minted goal follow-up (the steering lane for the budget steer, the
/// follow-up lane for the continuation), the `goal_update` surfaces at
/// the moment the state changed, and the runner wakes.
pub type GoalAdmissionSink = std::sync::Arc<dyn Fn(GoalTurnEndWork) + Send + Sync>;

/// RLM recursion identity carried by a session's create command: the
/// session's depth in the recursion tree, its bound, its working directory
/// and persistence ids, and the default thinking level children inherit.
/// Engines hosting RLM children seed their child registry from it; engines
/// without children (the scripted harness) accept and ignore it.
#[derive(Debug, Clone, Default)]
pub struct RlmSessionIdentity {
    pub rlm_depth: u32,
    pub rlm_max_depth: Option<u32>,
    pub cwd: Option<String>,
    pub session_id: Option<String>,
    pub session_file: Option<String>,
    pub thinking: Option<String>,
    /// Verification seam: children of this session spawn with a scripted
    /// engine file (the TS child runtime inherits the parent's
    /// `sessionConfig`; the harness analog carries the create's
    /// `childScript` down the recursion). Product sessions carry `None`.
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
/// summarizer usage (persisted on the compaction entry, never on the wire
/// response, mirroring the TS `CompactionResult`/entry split).
#[derive(Debug, Clone, PartialEq)]
pub struct CompactionRun {
    /// TS `CompactionResult`: summary, firstKeptEntryId, tokensBefore,
    /// details.
    pub result: Value,
    /// Usage billed by the summarizer call(s), for the persisted entry.
    pub usage: Option<Value>,
    /// The full durable `compaction` record (TS `CompactionEntry`:
    /// details, fromHook, customInstructions, usage, and the harness
    /// digest snapshot), serialized from the engine's compaction entry.
    /// Null for scripted engines (a test seam with no real entry).
    pub entry: Value,
    /// The post-compaction `ipython_state` notice in its wire message form
    /// (`role: "custom"`) when the engine's kernel was running (TS
    /// `_syncKernelStateAfterCompaction`): already durable in the engine
    /// session and the live context; the worker persists it to the session
    /// store and broadcasts its `message_start`/`message_end` pair.
    pub ipython_state: Option<Value>,
}

/// How one compaction run ended (TS `compact` outcomes: result, skip,
/// "Compaction cancelled", or failure).
#[derive(Debug, Clone, PartialEq)]
pub enum CompactionOutcome {
    /// Compacted; the run carries the result and entry usage. Boxed: the
    /// run's insertion-ordered JSON maps (`preserve_order`, wire parity)
    /// would make this variant dwarf the skip/abort/fail variants
    /// (`large_enum_variant`).
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
    /// The model that served the call (`provider`, `modelId`) when the
    /// scripted response or the live engine names one: persisted on the
    /// `branch_summary` entry for the per-model cost fold.
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

/// Wire form of one side-question status (TS `SideQuestionStatus`).
pub const SIDE_QUESTION_STATUS_RUNNING: &str = "running";
pub const SIDE_QUESTION_STATUS_COMPLETE: &str = "complete";
pub const SIDE_QUESTION_STATUS_CANCELLED: &str = "cancelled";
pub const SIDE_QUESTION_STATUS_ERROR: &str = "error";

/// Wire form of one side-question event (TS `SideQuestionEvent`).
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
    /// The TS wire status of this outcome.
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
