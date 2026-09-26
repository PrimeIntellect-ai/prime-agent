//! The `Agent` class, porting `packages/agent/src/agent.ts`.
//!
//! Owns agent state, the steering/follow-up message queues, event listeners,
//! and the active-run lifecycle. The low-level loop comes from
//! [`crate::agent_loop`]; every event the loop emits is reduced into state here
//! (TS `processEvents`) and then awaited by listeners in subscription order.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use tokio::sync::watch;

use crate::abort::{AbortController, AbortSignal};
use crate::agent_loop::{
    AfterToolCallFn, AgentEventSink, AgentLoopConfig, BeforeToolCallFn, ConvertToLlmFn,
    GetContinuationMessagesFn, PollMessagesFn, ShouldStopAfterTurnFn, ShouldStopBeforeTurnFn,
    TransformContextFn,
};
use crate::stream::StreamFn;
use crate::types::{
    AgentEvent, AgentMessage, AgentTool, ImageContent, Model, ThinkingLevel, ToolExecutionMode,
    Usage,
};

/// Queue drain mode (TS `QueueMode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum QueueMode {
    /// Drain every batch at once.
    All,
    /// Drain one batch per poll (default).
    #[default]
    OneAtATime,
}

/// Why [`Agent::continue_run`] refused to start a continuation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AgentContinueErrorCode {
    #[error("busy")]
    Busy,
    #[error("nothing-to-continue")]
    NothingToContinue,
}

/// Typed precondition failure from [`Agent::continue_run`], so callers
/// classify by code instead of message text (TS `AgentContinueError`).
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct AgentContinueError {
    pub code: AgentContinueErrorCode,
    message: String,
}

impl AgentContinueError {
    fn new(code: AgentContinueErrorCode, message: impl Into<String>) -> Self {
        AgentContinueError {
            code,
            message: message.into(),
        }
    }
}

/// Snapshot of the public agent state (TS `AgentState`).
#[derive(Clone)]
pub struct AgentStateSnapshot {
    pub system_prompt: String,
    pub model: Model,
    pub thinking_level: ThinkingLevel,
    pub tools: Vec<Arc<dyn AgentTool>>,
    pub messages: Vec<AgentMessage>,
    pub is_streaming: bool,
    pub streaming_message: Option<AgentMessage>,
    pub pending_tool_calls: HashSet<String>,
    pub error_message: Option<String>,
}

/// Initial state accepted by [`AgentOptions`].
#[derive(Default)]
pub struct AgentInitialState {
    pub system_prompt: Option<String>,
    pub model: Option<Model>,
    pub thinking_level: Option<ThinkingLevel>,
    pub tools: Option<Vec<Arc<dyn AgentTool>>>,
    pub messages: Option<Vec<AgentMessage>>,
}

/// Options for constructing an [`Agent`] (TS `AgentOptions`).
///
/// Provider plumbing options of the TS type (`onPayload`, `onResponse`,
/// `transport`, `thinkingBudgets`) are provider-level concerns and land with
/// the `pa-ai` unification; the loop's request surface (temperature, max
/// tokens, reasoning, session id, API key) is carried by
/// [`crate::agent_loop::AgentLoopConfig`] / [`crate::stream::StreamRequestOptions`].
#[derive(Default)]
pub struct AgentOptions {
    pub initial_state: AgentInitialState,
    pub convert_to_llm: Option<ConvertToLlmFn>,
    pub transform_context: Option<TransformContextFn>,
    pub stream_fn: Option<StreamFn>,
    pub get_api_key: Option<crate::agent_loop::GetApiKeyFn>,
    pub before_tool_call: Option<BeforeToolCallFn>,
    pub after_tool_call: Option<AfterToolCallFn>,
    pub should_stop_after_turn: Option<ShouldStopAfterTurnFn>,
    pub should_stop_before_turn: Option<ShouldStopBeforeTurnFn>,
    pub get_continuation_messages: Option<GetContinuationMessagesFn>,
    pub steering_mode: Option<QueueMode>,
    pub follow_up_mode: Option<QueueMode>,
    pub session_id: Option<String>,
    pub tool_execution: Option<ToolExecutionMode>,
}

struct MutableAgentState {
    system_prompt: String,
    model: Model,
    thinking_level: ThinkingLevel,
    tools: Vec<Arc<dyn AgentTool>>,
    messages: Vec<AgentMessage>,
    is_streaming: bool,
    streaming_message: Option<AgentMessage>,
    pending_tool_calls: HashSet<String>,
    error_message: Option<String>,
}

impl Default for MutableAgentState {
    fn default() -> Self {
        MutableAgentState {
            system_prompt: String::new(),
            model: Model::unknown(),
            thinking_level: ThinkingLevel::Off,
            tools: Vec::new(),
            messages: Vec::new(),
            is_streaming: false,
            streaming_message: None,
            pending_tool_calls: HashSet::new(),
            error_message: None,
        }
    }
}

/// Port of TS `PendingMessageQueue`.
struct PendingMessageQueue {
    mode: QueueMode,
    batches: Vec<Vec<AgentMessage>>,
}

impl PendingMessageQueue {
    fn new(mode: QueueMode) -> Self {
        PendingMessageQueue {
            mode,
            batches: Vec::new(),
        }
    }

    fn enqueue(&mut self, message: AgentMessageBatch) {
        match message {
            AgentMessageBatch::Single(message) => self.batches.push(vec![message]),
            AgentMessageBatch::Batch(messages) => {
                if !messages.is_empty() {
                    self.batches.push(messages);
                }
            }
        }
    }

    fn has_items(&self) -> bool {
        !self.batches.is_empty()
    }

    fn drain(&mut self) -> Vec<AgentMessage> {
        if self.mode == QueueMode::All {
            let drained: Vec<AgentMessage> = self.batches.drain(..).flatten().collect();
            return drained;
        }
        if let Some(first) = self.batches.first().cloned() {
            self.batches.remove(0);
            return first;
        }
        Vec::new()
    }

    fn clear(&mut self) {
        self.batches.clear();
    }

    fn remove_where(&mut self, predicate: &dyn Fn(&AgentMessage) -> bool) -> Vec<AgentMessage> {
        let mut removed: Vec<AgentMessage> = Vec::new();
        let mut retained: Vec<Vec<AgentMessage>> = Vec::new();
        for batch in self.batches.drain(..) {
            if batch.iter().any(predicate) {
                removed.extend(batch);
            } else {
                retained.push(batch);
            }
        }
        self.batches = retained;
        removed
    }
}

/// One or a batch of messages queued through `steer`/`followUp`.
// The `Single` variant mirrors the TS union member shape; boxing both arms
// would complicate every call site for no memory benefit in queue paths.
#[allow(clippy::large_enum_variant)]
pub enum AgentMessageBatch {
    Single(AgentMessage),
    Batch(Vec<AgentMessage>),
}

impl From<AgentMessage> for AgentMessageBatch {
    fn from(message: AgentMessage) -> Self {
        AgentMessageBatch::Single(message)
    }
}

impl From<Vec<AgentMessage>> for AgentMessageBatch {
    fn from(messages: Vec<AgentMessage>) -> Self {
        AgentMessageBatch::Batch(messages)
    }
}

/// Prompt input: a message, a batch of messages, or text with optional images
/// (TS `prompt` overloads).
pub enum AgentPromptInput {
    Messages(Vec<AgentMessage>),
    Text {
        text: String,
        images: Vec<ImageContent>,
    },
}

impl AgentPromptInput {
    pub fn text(text: impl Into<String>) -> Self {
        AgentPromptInput::Text {
            text: text.into(),
            images: Vec::new(),
        }
    }
}

impl From<&str> for AgentPromptInput {
    fn from(text: &str) -> Self {
        AgentPromptInput::text(text)
    }
}

impl From<AgentMessage> for AgentPromptInput {
    fn from(message: AgentMessage) -> Self {
        AgentPromptInput::Messages(vec![message])
    }
}

impl From<Vec<AgentMessage>> for AgentPromptInput {
    fn from(messages: Vec<AgentMessage>) -> Self {
        AgentPromptInput::Messages(messages)
    }
}

type AgentEventListener = Arc<
    dyn Fn(AgentEvent, AbortSignal) -> crate::BoxFut<'static, anyhow::Result<()>> + Send + Sync,
>;

/// Unsubscribe handle mirroring the TS `unsubscribe` function returned by
/// `agent.subscribe`. Dropping the handle does NOT unsubscribe (TS semantics);
/// call [`Subscription::unsubscribe`] explicitly to remove the listener.
pub struct Subscription {
    agent: Option<Arc<AgentInner>>,
    id: u64,
}

impl Subscription {
    /// Remove the listener this handle owns (the TS `unsubscribe()` call).
    pub async fn unsubscribe(mut self) {
        if let Some(agent) = self.agent.take() {
            agent.remove_listener(self.id).await;
        }
    }
}

struct Shared {
    state: MutableAgentState,
    listeners: Vec<(u64, AgentEventListener)>,
    next_listener_id: u64,
}

struct ActiveRun {
    controller: AbortController,
    idle_tx: watch::Sender<bool>,
}

struct AgentInner {
    /// One lock serializes state reduction and listener awaits, mirroring the
    /// single-threaded TS event loop: emitted events are processed strictly in
    /// the order the loop emits them.
    shared: tokio::sync::Mutex<Shared>,
    steering_queue: Mutex<PendingMessageQueue>,
    follow_up_queue: Mutex<PendingMessageQueue>,
    /// Active-run bookkeeping. A plain mutex: never held across awaits.
    run: Mutex<Option<ActiveRun>>,
    convert_to_llm: ConvertToLlmFn,
    transform_context: Option<TransformContextFn>,
    stream_fn: Option<StreamFn>,
    get_api_key: Option<crate::agent_loop::GetApiKeyFn>,
    before_tool_call: Option<BeforeToolCallFn>,
    after_tool_call: Option<AfterToolCallFn>,
    should_stop_after_turn: Option<ShouldStopAfterTurnFn>,
    should_stop_before_turn: Option<ShouldStopBeforeTurnFn>,
    /// The natural-turn-end continuation hook (TS `agent.getContinuationMessages`):
    /// settable after construction so embeddings that assemble the session
    /// engine first (the goal continuation arms) can install it once their
    /// own state exists. A plain mutex: cloned at run-config build, never
    /// held across an await.
    get_continuation_messages: Mutex<Option<GetContinuationMessagesFn>>,
    session_id: Option<String>,
    tool_execution: ToolExecutionMode,
}

impl AgentInner {
    /// Remove a listener by id ([`Subscription::unsubscribe`]).
    async fn remove_listener(self: &Arc<Self>, id: u64) {
        let mut shared = self.shared.lock().await;
        shared
            .listeners
            .retain(|(listener_id, _)| *listener_id != id);
    }
}

impl AgentInner {
    fn current_signal(&self) -> Option<AbortSignal> {
        let run = self.run.lock().unwrap();
        run.as_ref().map(|run| run.controller.signal())
    }

    /// Port of `processEvents`: reduce the event into state, then await
    /// listeners in subscription order.
    async fn process_events(self: &Arc<Self>, event: AgentEvent) -> anyhow::Result<()> {
        let mut shared = self.shared.lock().await;

        match &event {
            AgentEvent::MessageStart { message } | AgentEvent::MessageUpdate { message, .. } => {
                shared.state.streaming_message = Some(message.clone());
            }
            AgentEvent::MessageEnd { message } => {
                shared.state.streaming_message = None;
                shared.state.messages.push(message.clone());
            }
            AgentEvent::ToolExecutionStart { tool_call_id, .. } => {
                shared.state.pending_tool_calls.insert(tool_call_id.clone());
            }
            AgentEvent::ToolExecutionEnd { tool_call_id, .. } => {
                shared.state.pending_tool_calls.remove(tool_call_id);
            }
            AgentEvent::TurnEnd { message, .. } => {
                if let AgentMessage::Standard(crate::types::Message::Assistant(assistant)) = message
                {
                    if let Some(error_message) = &assistant.error_message {
                        shared.state.error_message = Some(error_message.clone());
                    }
                }
            }
            AgentEvent::AgentEnd { .. } => {
                shared.state.streaming_message = None;
            }
            AgentEvent::AgentStart
            | AgentEvent::TurnStart
            | AgentEvent::ToolExecutionUpdate { .. } => {}
        }

        let Some(signal) = self.current_signal() else {
            return Err(anyhow::anyhow!("Agent listener invoked outside active run"));
        };

        let listeners: Vec<AgentEventListener> = shared
            .listeners
            .iter()
            .map(|(_, listener)| Arc::clone(listener))
            .collect();
        for listener in listeners {
            listener(event.clone(), signal.clone()).await?;
        }
        Ok(())
    }

    /// Port of `handleRunFailure`.
    async fn handle_run_failure(self: &Arc<Self>, error: &anyhow::Error, aborted: bool) {
        let failure_message = {
            let shared = self.shared.lock().await;
            let model = shared.state.model.clone();
            crate::types::AssistantMessage {
                content: vec![crate::types::AssistantContent::Text(
                    crate::types::TextContent {
                        text: String::new(),
                        text_signature: None,
                    },
                )],
                api: model.api.clone(),
                provider: model.provider.clone(),
                model: model.id,
                response_model: None,
                response_id: None,
                diagnostics: if aborted {
                    None
                } else {
                    Some(vec![crate::types::assistant_message_diagnostic(
                        "agent_lifecycle_failure",
                        error,
                        Some(serde_json::json!({ "source": "run_with_lifecycle" })),
                    )])
                },
                usage: Usage::zero(),
                stop_reason: if aborted {
                    crate::types::StopReason::Aborted
                } else {
                    crate::types::StopReason::Error
                },
                error_message: Some(format!("{error:#}")),
                stop_reason_raw: None,
                timestamp: crate::now_ms(),
            }
        };
        {
            let mut shared = self.shared.lock().await;
            shared
                .state
                .error_message
                .clone_from(&failure_message.error_message);
        }
        // TS swallows listener errors on the failure path (`.catch(() => undefined)`).
        let _ = self
            .process_events(AgentEvent::MessageStart {
                message: AgentMessage::Standard(crate::types::Message::Assistant(
                    failure_message.clone(),
                )),
            })
            .await;
        let _ = self
            .process_events(AgentEvent::MessageEnd {
                message: AgentMessage::Standard(crate::types::Message::Assistant(
                    failure_message.clone(),
                )),
            })
            .await;
        let _ = self
            .process_events(AgentEvent::AgentEnd {
                messages: vec![AgentMessage::Standard(crate::types::Message::Assistant(
                    failure_message.clone(),
                ))],
            })
            .await;
    }

    fn snapshot_locked(shared: &Shared) -> crate::types::AgentContext {
        crate::types::AgentContext {
            system_prompt: shared.state.system_prompt.clone(),
            messages: shared.state.messages.clone(),
            tools: shared.state.tools.clone(),
        }
    }

    fn loop_config(
        self: &Arc<Self>,
        shared: &Shared,
        skip_initial_steering_poll: bool,
    ) -> AgentLoopConfig {
        let skip_poll = Arc::new(std::sync::Mutex::new(skip_initial_steering_poll));
        let steering_inner = Arc::clone(self);
        let steering = {
            Arc::new(move || {
                let skip_poll = Arc::clone(&skip_poll);
                let inner = Arc::clone(&steering_inner);
                Box::pin(async move {
                    if *skip_poll.lock().unwrap() {
                        *skip_poll.lock().unwrap() = false;
                        return Ok(Vec::new());
                    }
                    Ok(inner.steering_queue.lock().unwrap().drain())
                }) as crate::BoxFut<'static, anyhow::Result<Vec<AgentMessage>>>
            }) as PollMessagesFn
        };
        let follow_up_inner = Arc::clone(self);
        let follow_up = {
            Arc::new(move || {
                let inner = Arc::clone(&follow_up_inner);
                Box::pin(async move { Ok(inner.follow_up_queue.lock().unwrap().drain()) })
                    as crate::BoxFut<'static, anyhow::Result<Vec<AgentMessage>>>
            }) as PollMessagesFn
        };
        let continuation = self.get_continuation_messages.lock().unwrap().clone();
        let should_stop_after_turn = self.should_stop_after_turn.clone();

        let mut config =
            AgentLoopConfig::new(shared.state.model.clone(), Arc::clone(&self.convert_to_llm));
        config.api_key = None;
        config.temperature = None;
        config.max_tokens = None;
        config.reasoning = shared.state.thinking_level;
        config.session_id.clone_from(&self.session_id);
        config.transform_context.clone_from(&self.transform_context);
        config.get_api_key.clone_from(&self.get_api_key);
        config.should_stop_after_turn = should_stop_after_turn;
        config
            .should_stop_before_turn
            .clone_from(&self.should_stop_before_turn);
        config.get_steering_messages = Some(steering);
        config.get_follow_up_messages = Some(follow_up);
        config.get_continuation_messages = continuation;
        config.tool_execution = self.tool_execution;
        config.before_tool_call.clone_from(&self.before_tool_call);
        config.after_tool_call.clone_from(&self.after_tool_call);
        config
    }

    /// Port of `runWithLifecycle`.
    async fn run_with_lifecycle<F, Fut>(self: &Arc<Self>, executor: F) -> anyhow::Result<()>
    where
        F: FnOnce(AbortSignal) -> Fut,
        Fut: std::future::Future<Output = anyhow::Result<()>>,
    {
        let controller = AbortController::new();
        let (idle_tx, _idle_rx) = watch::channel(false);
        {
            let mut run = self.run.lock().unwrap();
            if run.is_some() {
                anyhow::bail!("Agent is already processing.");
            }
            *run = Some(ActiveRun {
                controller: controller.clone(),
                idle_tx,
            });
        }
        let run_signal = controller.signal();

        {
            let mut shared = self.shared.lock().await;
            shared.state.is_streaming = true;
            shared.state.streaming_message = None;
            shared.state.error_message = None;
        }

        let result = executor(run_signal).await;
        if let Err(error) = &result {
            let aborted = self
                .current_signal()
                .is_some_and(|signal| signal.is_aborted());
            self.handle_run_failure(error, aborted).await;
        }

        // finishRun
        {
            let mut shared = self.shared.lock().await;
            shared.state.is_streaming = false;
            shared.state.streaming_message = None;
            shared.state.pending_tool_calls.clear();
        }
        {
            let mut run = self.run.lock().unwrap();
            if let Some(active) = run.take() {
                let _ = active.idle_tx.send(true);
            }
        }
        result
    }

    async fn run_prompt_messages(
        self: &Arc<Self>,
        messages: Vec<AgentMessage>,
        skip_initial_steering_poll: bool,
    ) -> anyhow::Result<()> {
        let inner = Arc::clone(self);
        self.run_with_lifecycle(|signal| async move {
            let (context, config) = {
                let shared = inner.shared.lock().await;
                (
                    Self::snapshot_locked(&shared),
                    inner.loop_config(&shared, skip_initial_steering_poll),
                )
            };
            let emit: AgentEventSink = {
                let inner = Arc::clone(&inner);
                Arc::new(move |event| {
                    let inner = Arc::clone(&inner);
                    Box::pin(async move { inner.process_events(event).await })
                })
            };
            crate::agent_loop::run_agent_loop(
                messages,
                context,
                &config,
                emit,
                Some(&signal),
                inner.stream_fn.as_ref(),
            )
            .await
            .map(|_| ())
        })
        .await
    }

    async fn run_continuation(self: &Arc<Self>) -> anyhow::Result<()> {
        let inner = Arc::clone(self);
        self.run_with_lifecycle(|signal| async move {
            let (context, config) = {
                let shared = inner.shared.lock().await;
                (
                    Self::snapshot_locked(&shared),
                    inner.loop_config(&shared, false),
                )
            };
            let emit: AgentEventSink = {
                let inner = Arc::clone(&inner);
                Arc::new(move |event| {
                    let inner = Arc::clone(&inner);
                    Box::pin(async move { inner.process_events(event).await })
                })
            };
            crate::agent_loop::run_agent_loop_continue(
                context,
                &config,
                emit,
                Some(&signal),
                inner.stream_fn.as_ref(),
            )
            .await
            .map(|_| ())
        })
        .await
    }

    /// Drains queued steering/follow-up messages as a run, mirroring the
    /// `runQueuedMessages` helper in `continue()`. Returns whether a run
    /// was started.
    async fn run_queued_messages(self: &Arc<Self>) -> anyhow::Result<bool> {
        let queued_steering = self.steering_queue.lock().unwrap().drain();
        if !queued_steering.is_empty() {
            self.run_prompt_messages(queued_steering, true).await?;
            return Ok(true);
        }
        let queued_follow_ups = self.follow_up_queue.lock().unwrap().drain();
        if !queued_follow_ups.is_empty() {
            self.run_prompt_messages(queued_follow_ups, false).await?;
            return Ok(true);
        }
        Ok(false)
    }

    /// Port of `normalizePromptInput`.
    fn normalize_prompt_input(input: AgentPromptInput) -> Vec<AgentMessage> {
        match input {
            AgentPromptInput::Messages(messages) => messages,
            AgentPromptInput::Text { text, images } => {
                let mut content = vec![crate::types::UserPart::Text(crate::types::TextContent {
                    text,
                    text_signature: None,
                })];
                for image in images {
                    content.push(crate::types::UserPart::Image(image));
                }
                vec![AgentMessage::Standard(crate::types::Message::User(
                    crate::types::UserMessage {
                        content: crate::types::UserContent::Parts(content),
                        timestamp: crate::now_ms(),
                    },
                ))]
            }
        }
    }
}

/// The public `Agent` (TS `class Agent`).
pub struct Agent {
    inner: Arc<AgentInner>,
}

impl Agent {
    pub fn new(options: AgentOptions) -> Self {
        let initial = options.initial_state;
        let state = MutableAgentState {
            system_prompt: initial.system_prompt.unwrap_or_default(),
            model: initial.model.unwrap_or_else(Model::unknown),
            thinking_level: initial.thinking_level.unwrap_or(ThinkingLevel::Off),
            tools: initial.tools.unwrap_or_default(),
            messages: initial.messages.unwrap_or_default(),
            ..MutableAgentState::default()
        };
        let inner = Arc::new(AgentInner {
            shared: tokio::sync::Mutex::new(Shared {
                state,
                listeners: Vec::new(),
                next_listener_id: 0,
            }),
            steering_queue: Mutex::new(PendingMessageQueue::new(
                options.steering_mode.unwrap_or(QueueMode::OneAtATime),
            )),
            follow_up_queue: Mutex::new(PendingMessageQueue::new(
                options.follow_up_mode.unwrap_or(QueueMode::OneAtATime),
            )),
            run: Mutex::new(None),
            convert_to_llm: options
                .convert_to_llm
                .unwrap_or_else(AgentLoopConfig::default_convert_to_llm),
            transform_context: options.transform_context,
            stream_fn: options.stream_fn,
            get_api_key: options.get_api_key,
            before_tool_call: options.before_tool_call,
            after_tool_call: options.after_tool_call,
            should_stop_after_turn: options.should_stop_after_turn,
            should_stop_before_turn: options.should_stop_before_turn,
            get_continuation_messages: Mutex::new(options.get_continuation_messages),
            session_id: options.session_id,
            tool_execution: options
                .tool_execution
                .unwrap_or(ToolExecutionMode::Parallel),
        });
        Agent { inner }
    }

    fn from_inner(inner: Arc<AgentInner>) -> Self {
        Agent { inner }
    }

    /// Subscribe to agent lifecycle events (TS `subscribe`).
    ///
    /// Listener futures are awaited in subscription order and are included in
    /// the current run's settlement; a failing listener fails the run (a
    /// `throw` in a TS listener). `agent_end` is the final emitted event for a
    /// run, but the agent becomes idle only after all awaited listeners for
    /// that event finish.
    pub async fn subscribe<F>(&self, listener: F) -> Subscription
    where
        F: Fn(AgentEvent, AbortSignal) -> crate::BoxFut<'static, anyhow::Result<()>>
            + Send
            + Sync
            + 'static,
    {
        let mut shared = self.inner.shared.lock().await;
        let id = shared.next_listener_id;
        shared.next_listener_id += 1;
        shared.listeners.push((id, Arc::new(listener)));
        drop(shared);
        Subscription {
            agent: Some(Arc::clone(&self.inner)),
            id,
        }
    }

    /// Unsubscribe by the id returned from [`Agent::subscribe`] (for callers
    /// not holding a [`Subscription`] guard).
    pub async fn unsubscribe(&self, id: u64) {
        let mut shared = self.inner.shared.lock().await;
        shared
            .listeners
            .retain(|(listener_id, _)| *listener_id != id);
    }

    /// Current agent state (snapshot).
    pub async fn state(&self) -> AgentStateSnapshot {
        let shared = self.inner.shared.lock().await;
        AgentStateSnapshot {
            system_prompt: shared.state.system_prompt.clone(),
            model: shared.state.model.clone(),
            thinking_level: shared.state.thinking_level,
            tools: shared.state.tools.clone(),
            messages: shared.state.messages.clone(),
            is_streaming: shared.state.is_streaming,
            streaming_message: shared.state.streaming_message.clone(),
            pending_tool_calls: shared.state.pending_tool_calls.clone(),
            error_message: shared.state.error_message.clone(),
        }
    }

    /// Set the system prompt used for future turns.
    pub async fn set_system_prompt(&self, system_prompt: impl Into<String>) {
        self.inner.shared.lock().await.state.system_prompt = system_prompt.into();
    }

    /// Set the model used for future turns.
    pub async fn set_model(&self, model: Model) {
        self.inner.shared.lock().await.state.model = model;
    }

    /// Set the requested reasoning level for future turns.
    pub async fn set_thinking_level(&self, level: ThinkingLevel) {
        self.inner.shared.lock().await.state.thinking_level = level;
    }

    /// Set the tools available to future turns (the array is owned; the TS
    /// setter copies the top-level array).
    pub async fn set_tools(&self, tools: Vec<Arc<dyn AgentTool>>) {
        self.inner.shared.lock().await.state.tools = tools;
    }

    /// Replace the transcript (the array is owned; the TS setter copies the
    /// top-level array).
    pub async fn set_messages(&self, messages: Vec<AgentMessage>) {
        self.inner.shared.lock().await.state.messages = messages;
    }

    /// The steering queue's mode.
    ///
    /// # Panics
    ///
    /// Panics if the `steering_queue` mutex is poisoned (another thread
    /// panicked while holding it).
    pub fn steering_mode(&self) -> QueueMode {
        self.inner.steering_queue.lock().unwrap().mode
    }

    /// Set the steering queue's mode.
    ///
    /// # Panics
    ///
    /// Panics if the `steering_queue` mutex is poisoned (another thread
    /// panicked while holding it).
    pub fn set_steering_mode(&self, mode: QueueMode) {
        self.inner.steering_queue.lock().unwrap().mode = mode;
    }

    /// The follow-up queue's mode.
    ///
    /// # Panics
    ///
    /// Panics if the `follow_up_queue` mutex is poisoned (another thread
    /// panicked while holding it).
    pub fn follow_up_mode(&self) -> QueueMode {
        self.inner.follow_up_queue.lock().unwrap().mode
    }

    /// Install or replace the natural-turn-end continuation hook (TS
    /// `_installAgentContinuationHook`'s seam: the embedding that owns the
    /// goal/autonomous continuation policy wires it after the agent exists).
    /// `None` uninstalls the hook; the loop's natural stop returns.
    ///
    /// # Panics
    ///
    /// Panics if the `get_continuation_messages` mutex is poisoned (another
    /// thread panicked while holding it).
    pub fn set_continuation_hook(&self, hook: Option<GetContinuationMessagesFn>) {
        *self.inner.get_continuation_messages.lock().unwrap() = hook;
    }

    /// Set the follow-up queue's mode.
    ///
    /// # Panics
    ///
    /// Panics if the `follow_up_queue` mutex is poisoned (another thread
    /// panicked while holding it).
    pub fn set_follow_up_mode(&self, mode: QueueMode) {
        self.inner.follow_up_queue.lock().unwrap().mode = mode;
    }

    /// Queue a message batch to be injected after the current assistant turn
    /// finishes (TS `steer`).
    ///
    /// # Panics
    ///
    /// Panics if the `steering_queue` mutex is poisoned (another thread
    /// panicked while holding it).
    pub fn steer(&self, message: impl Into<AgentMessageBatch>) {
        self.inner
            .steering_queue
            .lock()
            .unwrap()
            .enqueue(message.into());
    }

    /// Queue a message batch to run only after the agent would otherwise stop
    /// (TS `followUp`).
    ///
    /// # Panics
    ///
    /// Panics if the `follow_up_queue` mutex is poisoned (another thread
    /// panicked while holding it).
    pub fn follow_up(&self, message: impl Into<AgentMessageBatch>) {
        self.inner
            .follow_up_queue
            .lock()
            .unwrap()
            .enqueue(message.into());
    }

    /// Clear the steering queue.
    ///
    /// # Panics
    ///
    /// Panics if the `steering_queue` mutex is poisoned (another thread
    /// panicked while holding it).
    pub fn clear_steering_queue(&self) {
        self.inner.steering_queue.lock().unwrap().clear();
    }

    /// Clear the follow-up queue.
    ///
    /// # Panics
    ///
    /// Panics if the `follow_up_queue` mutex is poisoned (another thread
    /// panicked while holding it).
    pub fn clear_follow_up_queue(&self) {
        self.inner.follow_up_queue.lock().unwrap().clear();
    }

    pub fn clear_all_queues(&self) {
        self.clear_steering_queue();
        self.clear_follow_up_queue();
    }

    /// Remove queued messages matching a predicate (TS `removeQueuedMessages`).
    ///
    /// # Panics
    ///
    /// Panics if the `steering_queue` or `follow_up_queue` mutex is poisoned
    /// (another thread panicked while holding one of them).
    pub fn remove_queued_messages(
        &self,
        predicate: impl Fn(&AgentMessage) -> bool,
    ) -> Vec<AgentMessage> {
        let mut removed = Vec::new();
        {
            let mut queue = self.inner.steering_queue.lock().unwrap();
            removed.extend(queue.remove_where(&predicate));
        }
        {
            let mut queue = self.inner.follow_up_queue.lock().unwrap();
            removed.extend(queue.remove_where(&predicate));
        }
        removed
    }

    /// Whether any steering or follow-up messages are queued.
    ///
    /// # Panics
    ///
    /// Panics if the `steering_queue` or `follow_up_queue` mutex is poisoned
    /// (another thread panicked while holding one of them).
    pub fn has_queued_messages(&self) -> bool {
        self.inner.steering_queue.lock().unwrap().has_items()
            || self.inner.follow_up_queue.lock().unwrap().has_items()
    }

    /// The loop's provider stream function (the side-thread clone passes the
    /// same function to its own loop, TS `parent.streamFn`).
    pub fn stream_fn(&self) -> Option<&StreamFn> {
        self.inner.stream_fn.as_ref()
    }

    /// The active run's abort signal, if any (TS `get signal`).
    pub fn signal(&self) -> Option<AbortSignal> {
        self.inner.current_signal()
    }

    /// Abort the active run (TS `abort`).
    ///
    /// # Panics
    ///
    /// Panics if the `run` mutex is poisoned (another thread panicked while
    /// holding it).
    pub fn abort(&self) {
        if let Some(run) = self.inner.run.lock().unwrap().as_ref() {
            run.controller.abort();
        }
    }

    /// Resolve when the current run and all awaited event listeners have
    /// finished - after `agent_end` listeners settle (TS `waitForIdle`).
    ///
    /// # Panics
    ///
    /// Panics if the `run` mutex is poisoned (another thread panicked while
    /// holding it).
    pub async fn wait_for_idle(&self) {
        let idle_rx = {
            let run = self.inner.run.lock().unwrap();
            run.as_ref().map(|run| run.idle_tx.subscribe())
        };
        // If no run slot exists the run may still be finishing; watch until the
        // slot is present and settles, or nothing is active at all.
        let Some(mut idle_rx) = idle_rx else {
            return;
        };
        loop {
            if *idle_rx.borrow_and_update() {
                return;
            }
            if idle_rx.changed().await.is_err() {
                // The active run slot was taken (finished) without a final
                // notification; treat as idle.
                return;
            }
        }
    }

    /// Reset the transcript and queued messages (TS `reset`).
    pub async fn reset(&self) {
        {
            let mut shared = self.inner.shared.lock().await;
            shared.state.messages.clear();
            shared.state.is_streaming = false;
            shared.state.streaming_message = None;
            shared.state.pending_tool_calls.clear();
            shared.state.error_message = None;
        }
        self.clear_follow_up_queue();
        self.clear_steering_queue();
    }

    /// Run the loop with a new prompt (TS `prompt`).
    ///
    /// # Errors
    ///
    /// Errors with the TS message when a run is already active; use `steer()`
    /// or `follow_up()` to queue messages instead. Otherwise the result of the
    /// run started by this prompt is propagated, so it errors if that run
    /// fails.
    ///
    /// # Panics
    ///
    /// Panics if the `run` mutex is poisoned (another thread panicked while
    /// holding it).
    pub async fn prompt(&self, input: impl Into<AgentPromptInput>) -> anyhow::Result<()> {
        if self.inner.run.lock().unwrap().is_some() {
            anyhow::bail!(
                "Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion."
            );
        }
        let messages = AgentInner::normalize_prompt_input(input.into());
        self.inner.run_prompt_messages(messages, false).await
    }

    /// Continue from the current context (TS `continue`).
    ///
    /// Returns typed [`AgentContinueError`] failures inside `anyhow::Error`;
    /// downcast with `error.downcast_ref::<AgentContinueError>()`.
    ///
    /// # Errors
    ///
    /// Returns an [`AgentContinueError`] wrapped in `anyhow::Error`: code
    /// `Busy` when a run is already active, or code `NothingToContinue` when
    /// there is nothing to continue from. Errors from running queued messages
    /// and the result of the continuation run are propagated as well.
    ///
    /// # Panics
    ///
    /// Panics if the `run` mutex is poisoned (another thread panicked while
    /// holding it).
    pub async fn continue_run(&self) -> anyhow::Result<()> {
        if self.inner.run.lock().unwrap().is_some() {
            return Err(anyhow::Error::new(AgentContinueError::new(
                AgentContinueErrorCode::Busy,
                "Agent is already processing. Wait for completion before continuing.",
            )));
        }

        let last_message = {
            let shared = self.inner.shared.lock().await;
            shared.state.messages.last().cloned()
        };

        let Some(last_message) = last_message else {
            if self.inner.run_queued_messages().await? {
                return Ok(());
            }
            return Err(anyhow::Error::new(AgentContinueError::new(
                AgentContinueErrorCode::NothingToContinue,
                "No messages to continue from",
            )));
        };

        let role = last_message.role().to_string();
        if role == "assistant" {
            if self.inner.run_queued_messages().await? {
                return Ok(());
            }
            return Err(anyhow::Error::new(AgentContinueError::new(
                AgentContinueErrorCode::NothingToContinue,
                "Cannot continue from message role: assistant",
            )));
        }

        if role == "custom" && self.inner.run_queued_messages().await? {
            return Ok(());
        }

        self.inner.run_continuation().await
    }

    /// The loop's event sink for external embedding: forwards events through
    /// this agent's listener processing (not part of the TS public API; the
    /// TS class keeps this private).
    pub fn event_sink(self: &Arc<Self>) -> AgentEventSink {
        let inner = Arc::clone(&self.inner);
        Arc::new(move |event| {
            let inner = Arc::clone(&inner);
            Box::pin(async move { inner.process_events(event).await })
        })
    }
}

impl Clone for Agent {
    fn clone(&self) -> Self {
        Agent::from_inner(Arc::clone(&self.inner))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_message_queue_all_mode_flattens() {
        let mut queue = PendingMessageQueue::new(QueueMode::All);
        queue.enqueue(AgentMessageBatch::Single(AgentMessage::user("a")));
        queue.enqueue(AgentMessageBatch::Batch(vec![
            AgentMessage::user("b"),
            AgentMessage::user("c"),
        ]));
        let drained = queue.drain();
        assert_eq!(drained.len(), 3);
        assert!(!queue.has_items());
    }

    #[test]
    fn pending_message_queue_one_at_a_time_keeps_batches() {
        let mut queue = PendingMessageQueue::new(QueueMode::OneAtATime);
        queue.enqueue(AgentMessageBatch::Single(AgentMessage::user("a")));
        queue.enqueue(AgentMessageBatch::Batch(vec![
            AgentMessage::user("b"),
            AgentMessage::user("c"),
        ]));
        let drained = queue.drain();
        assert_eq!(drained.len(), 1);
        assert!(queue.has_items());
        assert_eq!(queue.drain().len(), 2);
    }

    #[test]
    fn remove_where_drops_matching_batches() {
        let mut queue = PendingMessageQueue::new(QueueMode::OneAtATime);
        queue.enqueue(AgentMessageBatch::Single(AgentMessage::user("drop-me")));
        queue.enqueue(AgentMessageBatch::Single(AgentMessage::user("keep-me")));
        let removed = queue.remove_where(&|m| matches!(m, AgentMessage::Standard(crate::types::Message::User(u)) if matches!(&u.content, crate::types::UserContent::Text(t) if t.contains("drop"))));
        assert_eq!(removed.len(), 1);
        assert!(queue.has_items());
    }
}
