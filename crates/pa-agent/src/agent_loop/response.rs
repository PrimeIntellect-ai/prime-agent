//! Streaming one assistant response (TS `streamAssistantResponse`): context
//! transform, LLM-bound message conversion, the model stream event loop, and
//! the aborted-message finalize path. Section of the port of
//! `packages/agent/src/agent-loop.ts`.

use crate::abort::{is_abort_error, AbortSignal};
use crate::stream::{LlmContext, StreamFn, StreamRequestOptions, ToolDefinition};
use crate::types::{AgentContext, AgentEvent, AgentMessage, AssistantMessage};

use super::abort::{create_aborted_assistant_message, race_with_abort};
use super::{AgentEventSink, AgentLoopConfig};

// ---------------------------------------------------------------------------
// Streaming one assistant response
// ---------------------------------------------------------------------------

/// Port of `streamAssistantResponse`.
pub(crate) async fn stream_assistant_response(
    context: &mut AgentContext,
    config: &AgentLoopConfig,
    signal: Option<&AbortSignal>,
    emit: &AgentEventSink,
    stream_fn: Option<&StreamFn>,
) -> anyhow::Result<AssistantMessage> {
    let mut partial_message: Option<AssistantMessage> = None;
    let mut added_partial = false;

    // The TS closure captures `partialMessage`/`addedPartial` by reference;
    // here the finish helper runs inline in the abort path below.
    macro_rules! finish_aborted_message {
        () => {{
            let final_message = create_aborted_assistant_message(config, partial_message.as_ref());
            if added_partial {
                *context.messages.last_mut().unwrap() = AgentMessage::from(final_message.clone());
            } else {
                context
                    .messages
                    .push(AgentMessage::from(final_message.clone()));
                emit(AgentEvent::MessageStart {
                    message: AgentMessage::from(final_message.clone()),
                })
                .await?;
            }
            emit(AgentEvent::MessageEnd {
                message: AgentMessage::from(final_message.clone()),
            })
            .await?;
            final_message
        }};
    }

    let result = stream_assistant_response_inner(
        context,
        config,
        signal,
        emit,
        stream_fn,
        &mut partial_message,
        &mut added_partial,
    )
    .await;

    match result {
        Ok(message) => Ok(message),
        Err(error) => {
            if signal.map(AbortSignal::is_aborted).unwrap_or(false) && is_abort_error(&error) {
                return Ok(finish_aborted_message!());
            }
            Err(error)
        }
    }
}

/// Inner body of `streamAssistantResponse` (the TS `try` block).
async fn stream_assistant_response_inner(
    context: &mut AgentContext,
    config: &AgentLoopConfig,
    signal: Option<&AbortSignal>,
    emit: &AgentEventSink,
    stream_fn: Option<&StreamFn>,
    partial_message: &mut Option<AssistantMessage>,
    added_partial: &mut bool,
) -> anyhow::Result<AssistantMessage> {
    crate::abort::throw_if_aborted_signal(signal)?;

    let mut messages: Vec<AgentMessage> = context.messages.clone();
    if let Some(transform) = config.transform_context.as_ref() {
        messages = race_with_abort(
            transform(messages, signal.cloned().unwrap_or_default()),
            signal,
        )
        .await?;
    }

    let llm_messages = race_with_abort((config.convert_to_llm)(messages), signal).await?;

    let stream_fn = stream_fn.ok_or_else(|| {
        anyhow::anyhow!(
            "No stream function provided; the agent loop requires a model stream function (pa-ai integration supplies the default)"
        )
    })?;

    let resolved_api_key = match config.get_api_key.as_ref() {
        Some(get_api_key) => {
            match race_with_abort(get_api_key(config.model.provider.clone()), signal).await? {
                Some(key) => Some(key),
                None => config.api_key.clone(),
            }
        }
        None => config.api_key.clone(),
    };

    let llm_context = LlmContext {
        system_prompt: Some(
            config
                .get_system_prompt
                .as_ref()
                .map(|hook| hook())
                .unwrap_or_else(|| context.system_prompt.clone()),
        ),
        messages: llm_messages,
        tools: context
            .tools
            .iter()
            .map(|tool| ToolDefinition {
                name: tool.name().to_string(),
                description: tool.description().to_string(),
                parameters: tool.parameters().clone(),
            })
            .collect(),
    };

    let options = StreamRequestOptions {
        temperature: config.temperature,
        max_tokens: config.max_tokens,
        reasoning: config.reasoning,
        session_id: config.session_id.clone(),
        api_key: resolved_api_key,
        signal: signal.cloned().unwrap_or_default(),
    };

    let mut response = race_with_abort(
        stream_fn(config.model.clone(), llm_context, options),
        signal,
    )
    .await?;

    loop {
        let next = match signal {
            Some(signal) => {
                // TS races the iterator with `closeIterator` as the abort
                // callback: cancel the stream when the user aborts mid-read.
                let result = crate::abort::race_with_abort(response.next_event(), signal).await;
                if result.is_err() {
                    response.close();
                }
                result?
            }
            None => response.next_event().await,
        };
        let Some(event) = next else {
            break;
        };

        match &event {
            crate::stream::AssistantMessageEvent::Start { partial } => {
                *partial_message = Some(partial.clone());
                context.messages.push(AgentMessage::from(partial.clone()));
                *added_partial = true;
                emit(AgentEvent::MessageStart {
                    message: AgentMessage::from(partial.clone()),
                })
                .await?;
            }
            event if event.is_delta() => {
                if let Some(partial) = event_partial(event) {
                    *partial_message = Some(partial.clone());
                    *context.messages.last_mut().unwrap() = AgentMessage::from(partial.clone());
                    emit(AgentEvent::MessageUpdate {
                        message: AgentMessage::from(partial.clone()),
                        assistant_message_event: Box::new(event.clone()),
                    })
                    .await?;
                }
            }
            event if event.terminal_message().is_some() => {
                let mut final_message = event.terminal_message().unwrap().clone();
                match race_with_abort(response.result(), signal).await {
                    Ok(result_message) => final_message = result_message,
                    Err(error) => {
                        let aborted = signal.map(AbortSignal::is_aborted).unwrap_or(false);
                        if !(aborted && is_abort_error(&error)) {
                            return Err(error);
                        }
                    }
                }
                if *added_partial {
                    *context.messages.last_mut().unwrap() =
                        AgentMessage::from(final_message.clone());
                } else {
                    context
                        .messages
                        .push(AgentMessage::from(final_message.clone()));
                }
                if !*added_partial {
                    emit(AgentEvent::MessageStart {
                        message: AgentMessage::from(final_message.clone()),
                    })
                    .await?;
                }
                emit(AgentEvent::MessageEnd {
                    message: AgentMessage::from(final_message.clone()),
                })
                .await?;
                return Ok(final_message);
            }
            _ => {}
        }
    }

    // Stream ended without a terminal event: resolve the final message (TS
    // awaits `response.result()` here too; a stream that ends cleanly always
    // pushed done/error first).
    let final_message = race_with_abort(response.result(), signal).await?;
    if *added_partial {
        *context.messages.last_mut().unwrap() = AgentMessage::from(final_message.clone());
    } else {
        context
            .messages
            .push(AgentMessage::from(final_message.clone()));
        emit(AgentEvent::MessageStart {
            message: AgentMessage::from(final_message.clone()),
        })
        .await?;
    }
    emit(AgentEvent::MessageEnd {
        message: AgentMessage::from(final_message.clone()),
    })
    .await?;
    Ok(final_message)
}

fn event_partial(event: &crate::stream::AssistantMessageEvent) -> Option<&AssistantMessage> {
    match event {
        crate::stream::AssistantMessageEvent::Start { partial }
        | crate::stream::AssistantMessageEvent::TextStart { partial, .. }
        | crate::stream::AssistantMessageEvent::TextDelta { partial, .. }
        | crate::stream::AssistantMessageEvent::TextEnd { partial, .. }
        | crate::stream::AssistantMessageEvent::ThinkingStart { partial, .. }
        | crate::stream::AssistantMessageEvent::ThinkingDelta { partial, .. }
        | crate::stream::AssistantMessageEvent::ThinkingEnd { partial, .. }
        | crate::stream::AssistantMessageEvent::ToolCallStart { partial, .. }
        | crate::stream::AssistantMessageEvent::ToolCallDelta { partial, .. }
        | crate::stream::AssistantMessageEvent::ToolCallEnd { partial, .. } => Some(partial),
        _ => None,
    }
}
