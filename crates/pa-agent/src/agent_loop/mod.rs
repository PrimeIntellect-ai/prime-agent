//! The low-level agent loop, porting `packages/agent/src/agent-loop.ts` line
//! by line where possible.
//!
//! The loop works with [`types::AgentMessage`] throughout and converts to
//! LLM-bound [`types::Message`] values only at the model call boundary.
//! Model streaming goes through the minimal local [`crate::stream::ModelStream`]
//! trait.
//!
//! Split across submodules: the hook types and [`AgentLoopConfig`] live here,
//! abort/settlement helpers and aborted-message construction in [`abort`],
//! the public entry points in [`entry`], the turn loop in [`run`], streaming
//! one assistant response in [`response`], and tool execution in [`tools`]
//! and [`tool_call`].

//! LLM-bound [`types::Message`] values only at the model call boundary.
//! Model streaming goes through the minimal local [`crate::stream::ModelStream`]
//! trait.

use std::sync::Arc;

use crate::abort::AbortSignal;
use crate::types::{
    AfterToolCallContext, AfterToolCallResult, AgentEvent, AgentMessage, BeforeToolCallContext,
    BeforeToolCallResult, GetContinuationMessagesContext, Message, Model,
    ShouldStopAfterTurnContext, ThinkingLevel, ToolExecutionMode,
};

/// Sink receiving the loop's events. The loop awaits every emission, so
/// listeners see events strictly in order (TS `AgentEventSink`).
pub type AgentEventSink =
    Arc<dyn Fn(AgentEvent) -> crate::BoxFut<'static, anyhow::Result<()>> + Send + Sync>;

// ---------------------------------------------------------------------------
// Hook types (AgentLoopConfig)
// ---------------------------------------------------------------------------

/// `convertToLlm`: converts `AgentMessage`s to LLM-compatible `Message`s before
/// each call. Must not fail (TS contract); a returned `Err` interrupts the
/// loop like a `throw` in the TS reference.
pub type ConvertToLlmFn = Arc<
    dyn Fn(Vec<AgentMessage>) -> crate::BoxFut<'static, anyhow::Result<Vec<Message>>> + Send + Sync,
>;

/// `transformContext`: AgentMessage-level transform applied before
/// `convert_to_llm` (context pruning, external injection).
pub type TransformContextFn = Arc<
    dyn Fn(
            Vec<AgentMessage>,
            AbortSignal,
        ) -> crate::BoxFut<'static, anyhow::Result<Vec<AgentMessage>>>
        + Send
        + Sync,
>;

/// Resolves the system prompt immediately before each LLM call.
pub type GetSystemPromptFn = Arc<dyn Fn() -> String + Send + Sync>;

/// Resolves an API key dynamically for each LLM call.
pub type GetApiKeyFn =
    Arc<dyn Fn(String) -> crate::BoxFut<'static, anyhow::Result<Option<String>>> + Send + Sync>;

/// Called after each turn fully completes and `turn_end` was emitted; return
/// true to stop the run before polling steering/follow-up queues.
pub type ShouldStopAfterTurnFn = Arc<
    dyn Fn(ShouldStopAfterTurnContext) -> crate::BoxFut<'static, anyhow::Result<bool>>
        + Send
        + Sync,
>;

/// Called synchronously after a completed turn and before polling for another
/// turn; never checked before the initial assistant turn.
pub type ShouldStopBeforeTurnFn = Arc<dyn Fn() -> bool + Send + Sync>;

/// Returns steering messages to inject mid-run.
pub type PollMessagesFn =
    Arc<dyn Fn() -> crate::BoxFut<'static, anyhow::Result<Vec<AgentMessage>>> + Send + Sync>;

/// Returns continuation messages when the agent would otherwise stop.
pub type GetContinuationMessagesFn = Arc<
    dyn Fn(
            GetContinuationMessagesContext,
            AbortSignal,
        ) -> crate::BoxFut<'static, anyhow::Result<Vec<AgentMessage>>>
        + Send
        + Sync,
>;

/// `beforeToolCall`: return `{ block: true }` to prevent execution.
pub type BeforeToolCallFn = Arc<
    dyn Fn(
            BeforeToolCallContext,
            AbortSignal,
        ) -> crate::BoxFut<'static, anyhow::Result<Option<BeforeToolCallResult>>>
        + Send
        + Sync,
>;

/// `afterToolCall`: partial override of the executed tool result.
pub type AfterToolCallFn = Arc<
    dyn Fn(
            AfterToolCallContext,
            AbortSignal,
        ) -> crate::BoxFut<'static, anyhow::Result<Option<AfterToolCallResult>>>
        + Send
        + Sync,
>;

/// Configuration for the agent loop (TS `AgentLoopConfig`).
#[derive(Clone)]
pub struct AgentLoopConfig {
    pub model: Model,
    pub api_key: Option<String>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<u64>,
    pub reasoning: ThinkingLevel,
    pub session_id: Option<String>,
    pub convert_to_llm: ConvertToLlmFn,
    pub transform_context: Option<TransformContextFn>,
    pub get_system_prompt: Option<GetSystemPromptFn>,
    pub get_api_key: Option<GetApiKeyFn>,
    pub should_stop_after_turn: Option<ShouldStopAfterTurnFn>,
    pub should_stop_before_turn: Option<ShouldStopBeforeTurnFn>,
    pub get_steering_messages: Option<PollMessagesFn>,
    pub get_follow_up_messages: Option<PollMessagesFn>,
    pub get_continuation_messages: Option<GetContinuationMessagesFn>,
    /// Tool execution mode. Defaults to parallel (TS default).
    pub tool_execution: ToolExecutionMode,
    pub before_tool_call: Option<BeforeToolCallFn>,
    pub after_tool_call: Option<AfterToolCallFn>,
}

impl AgentLoopConfig {
    /// Config with a pass-through `convert_to_llm` (keeps user/assistant/
    /// toolResult messages, filters everything else) and no hooks, matching
    /// the TS defaults where hooks are optional.
    pub fn new(model: Model, convert_to_llm: ConvertToLlmFn) -> Self {
        AgentLoopConfig {
            model,
            api_key: None,
            temperature: None,
            max_tokens: None,
            reasoning: ThinkingLevel::Off,
            session_id: None,
            convert_to_llm,
            transform_context: None,
            get_system_prompt: None,
            get_api_key: None,
            should_stop_after_turn: None,
            should_stop_before_turn: None,
            get_steering_messages: None,
            get_follow_up_messages: None,
            get_continuation_messages: None,
            tool_execution: ToolExecutionMode::Parallel,
            before_tool_call: None,
            after_tool_call: None,
        }
    }

    pub fn default_convert_to_llm() -> ConvertToLlmFn {
        Arc::new(|messages: Vec<AgentMessage>| {
            Box::pin(async move {
                Ok(messages
                    .into_iter()
                    .filter(|m| {
                        matches!(
                            m,
                            AgentMessage::Standard(Message::User(_))
                                | AgentMessage::Standard(Message::Assistant(_))
                                | AgentMessage::Standard(Message::ToolResult(_))
                        )
                    })
                    .map(|m| match m {
                        AgentMessage::Standard(message) => message,
                        AgentMessage::Custom(_) => unreachable!("filtered above"),
                    })
                    .collect())
            })
        })
    }
}

mod abort;
mod entry;
mod response;
mod run;
mod tool_call;
mod tools;

pub use entry::{run_agent_loop, run_agent_loop_continue};
