//! The turn loop's vocabulary: the per-turn outcome and admission
//! types and the retry/abort message helpers that shape them.
use super::{EngineEvent, Model, StopReason};

/// The outcome of one admitted turn.
pub(crate) enum TurnResult {
    /// The turn settled; the final assistant message (typed, boxed to
    /// keep the enum small).
    Message(Box<pa_agent::types::AssistantMessage>),
    /// The turn was aborted before a settled message.
    Aborted,
    /// The turn failed before or during the model call; `assistant` is
    /// the failed turn's settled message when one exists (model
    /// resolution and session-build failures carry none).
    Error {
        error: String,
        assistant: Option<Box<pa_agent::types::AssistantMessage>>,
    },
}

/// How one turn is admitted to the agent loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TurnAdmission {
    /// A fresh user prompt: the loop context gains the user message.
    FreshPrompt,
    /// Re-issue the loop without a new user message, after the failed
    /// turn's error message left the loop context.
    Continue,
}

/// The first turn's admitted prompt: a plain user prompt, or an
/// injected custom row the turn runs on.
#[derive(Debug, Clone)]
pub(crate) enum TurnPrompt {
    /// A user prompt: text plus images, with the batched co-delivery
    /// rows riding the same run after the primary.
    User {
        text: String,
        images: Vec<pa_agent::types::ImageContent>,
        batch: Vec<crate::engine::PromptBatchRow>,
    },
    /// An injected custom row (goal continuations, RLM child terminal
    /// notices): the admission carries the row itself, so the transcript
    /// holds one representation.
    Injected(pa_types::session::CustomMessage),
}

/// What the turn-boundary consumption did to the run.
pub(crate) enum BoundaryRun {
    /// Nothing pending, or requests consumed without stopping the run.
    Proceed,
    /// A consumed compaction stops the loop. `compacted` marks the runs
    /// that actually compacted — the only arm whose post-compaction goal
    /// consult mints.
    StoppedForCompaction { compacted: bool },
    /// The emitter asked to stop.
    Cancelled,
}

/// The outcome of one turn attempt.
pub(crate) enum TurnOnce {
    /// The emit callback cancelled the run.
    Aborted,
    /// The turn produced no assistant message.
    None,
    /// The turn's final assistant message (retry classification).
    Message {
        assistant: Box<pa_agent::types::AssistantMessage>,
    },
}

/// Remove the trailing assistant message from the loop context, so a
/// retried request does not re-send the failed turn's error message.
pub(crate) async fn drop_trailing_assistant(agent: &std::sync::Arc<pa_agent::agent::Agent>) {
    let state = agent.state().await;
    let mut messages = state.messages;
    if matches!(
        messages.last(),
        Some(pa_agent::types::AgentMessage::Standard(
            pa_agent::types::Message::Assistant(_)
        ))
    ) {
        messages.pop();
        agent.set_messages(messages).await;
    }
}

/// The synthesized aborted assistant message (an abort racing the turn ends
/// the loop without a provider failure).
pub(crate) fn aborted_message(model: &Model) -> pa_agent::types::AssistantMessage {
    pa_agent::types::AssistantMessage {
        content: vec![pa_agent::types::AssistantContent::Text(
            pa_agent::types::TextContent {
                text: String::new(),
                text_signature: None,
            },
        )],
        api: model.api.clone(),
        provider: model.provider.clone(),
        model: model.id.clone(),
        response_model: None,
        response_id: None,
        diagnostics: None,
        usage: pa_agent::types::Usage::zero(),
        stop_reason: StopReason::Aborted,
        stop_reason_raw: None,
        error_message: None,
        timestamp: pa_agent::now_ms(),
    }
}

/// Translate one retry-loop event to the engine event vocabulary.
pub(crate) fn retry_event_to_engine_event(
    event: pa_core::session_engine::auto_retry::AutoRetryEvent,
) -> EngineEvent {
    use pa_core::session_engine::auto_retry::AutoRetryEvent;
    match event {
        AutoRetryEvent::Start {
            attempt,
            max_attempts,
            delay_ms,
            error_message,
            reason,
        } => EngineEvent::AutoRetryStart {
            attempt,
            max_attempts,
            delay_ms,
            error_message,
            reason,
        },
        AutoRetryEvent::End {
            success,
            attempt,
            final_error,
            restored_model,
        } => EngineEvent::AutoRetryEnd {
            success,
            attempt,
            final_error,
            restored_model,
        },
    }
}
