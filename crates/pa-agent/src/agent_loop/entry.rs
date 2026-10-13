//! Public entry points of the agent loop.

use crate::abort::AbortSignal;
use crate::stream::StreamFn;
use crate::types::{AgentContext, AgentEvent, AgentMessage};

use super::run::run_loop;
use super::{AgentEventSink, AgentLoopConfig};

/// Start an agent loop with new prompt messages. Returns every message produced by the run.
///
/// # Errors
///
/// Returns an error if an emitted event fails to send, or the run fails.
pub async fn run_agent_loop(
    prompts: Vec<AgentMessage>,
    context: AgentContext,
    config: &AgentLoopConfig,
    emit: AgentEventSink,
    signal: Option<&AbortSignal>,
    stream_fn: Option<&StreamFn>,
) -> anyhow::Result<Vec<AgentMessage>> {
    let mut new_messages: Vec<AgentMessage> = prompts.clone();
    let mut current_context = AgentContext {
        system_prompt: context.system_prompt.clone(),
        tools: context.tools.clone(),
        messages: context.messages.clone(),
    };
    current_context.messages.extend(prompts.iter().cloned());

    emit(AgentEvent::AgentStart).await?;
    emit(AgentEvent::TurnStart).await?;
    for prompt in &prompts {
        emit(AgentEvent::MessageStart {
            message: prompt.clone(),
        })
        .await?;
        emit(AgentEvent::MessageEnd {
            message: prompt.clone(),
        })
        .await?;
    }

    run_loop(
        &mut current_context,
        &mut new_messages,
        config,
        signal,
        &emit,
        stream_fn,
    )
    .await?;
    Ok(new_messages)
}

/// Continue an agent loop from the current context without adding a new
/// message. Used for retries. The last message in context must convert to
/// a `user` or `toolResult` message via `convert_to_llm`.
///
/// # Errors
///
/// Errors if the context has no messages, the last message has role `assistant`, or the run fails.
///
/// # Panics
///
/// The `unwrap` on the last context message is unreachable: an empty context errors earlier.
pub async fn run_agent_loop_continue(
    context: AgentContext,
    config: &AgentLoopConfig,
    emit: AgentEventSink,
    signal: Option<&AbortSignal>,
    stream_fn: Option<&StreamFn>,
) -> anyhow::Result<Vec<AgentMessage>> {
    if context.messages.is_empty() {
        anyhow::bail!("Cannot continue: no messages in context");
    }
    if context.messages.last().unwrap().role() == "assistant" {
        anyhow::bail!("Cannot continue from message role: assistant");
    }

    let mut new_messages: Vec<AgentMessage> = Vec::new();
    let mut current_context = context;

    emit(AgentEvent::AgentStart).await?;
    emit(AgentEvent::TurnStart).await?;

    run_loop(
        &mut current_context,
        &mut new_messages,
        config,
        signal,
        &emit,
        stream_fn,
    )
    .await?;
    Ok(new_messages)
}
