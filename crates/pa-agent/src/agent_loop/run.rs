//! The agent turn loop: assistant turns, tool-call batches,
//! steering/follow-up/continuation message polling, and stop-hook
//! evaluation.

use crate::abort::AbortSignal;
use crate::stream::StreamFn;
use crate::types::{
    AgentContext, AgentEvent, AgentMessage, ShouldStopAfterTurnContext, StopReason, ToolCall,
    ToolResultMessage,
};

use super::abort::{
    create_aborted_assistant_message, poll_messages_unless_aborted, race_with_abort,
    settle_post_turn, PostTurnResult,
};
use super::response::stream_assistant_response;
use super::tools::execute_tool_calls;
use super::{AgentEventSink, AgentLoopConfig, Continuation};

// Direct port of the TS turn loop.
#[allow(clippy::too_many_lines)]
pub(crate) async fn run_loop(
    current_context: &mut AgentContext,
    new_messages: &mut Vec<AgentMessage>,
    config: &AgentLoopConfig,
    signal: Option<&AbortSignal>,
    emit: &AgentEventSink,
    stream_fn: Option<&StreamFn>,
) -> anyhow::Result<()> {
    let mut first_turn = true;
    let mut stop_hook_active = false;
    let mut last_turn: Option<ShouldStopAfterTurnContext> = None;
    // Submitted batches pass the input gate where they are polled; internal
    // continuations do not. A rejected batch is dropped and the loop goes on.
    let mut pending_messages = admit_batch(
        poll_messages_unless_aborted(config.get_steering_messages.as_ref(), signal).await?,
        config,
        signal,
    )
    .await?;

    macro_rules! should_stop_before_turn {
        () => {
            !first_turn
                && config
                    .should_stop_before_turn
                    .as_ref()
                    .map(|hook| hook())
                    .unwrap_or(false)
        };
    }

    loop {
        crate::abort::throw_if_aborted_signal(signal)?;
        let mut has_more_tool_calls = true;

        while has_more_tool_calls || !pending_messages.is_empty() {
            crate::abort::throw_if_aborted_signal(signal)?;
            if first_turn {
                first_turn = false;
            } else {
                emit(AgentEvent::TurnStart).await?;
            }

            if !pending_messages.is_empty() {
                for message in pending_messages.drain(..) {
                    emit(AgentEvent::MessageStart {
                        message: message.clone(),
                    })
                    .await?;
                    emit(AgentEvent::MessageEnd {
                        message: message.clone(),
                    })
                    .await?;
                    current_context.messages.push(message.clone());
                    new_messages.push(message);
                }
            }

            if let Some(before_model) = &config.before_model {
                let gate = settle_post_turn(
                    race_with_abort(
                        before_model(config.model.clone(), signal.cloned().unwrap_or_default()),
                        signal,
                    ),
                    signal,
                )
                .await;
                match gate {
                    Ok(PostTurnResult::Completed(())) => {}
                    // Same settlement as an abort during the provider request.
                    Ok(PostTurnResult::Aborted) => {
                        let message = create_aborted_assistant_message(config, None);
                        let message = AgentMessage::from(message);
                        emit(AgentEvent::MessageStart {
                            message: message.clone(),
                        })
                        .await?;
                        emit(AgentEvent::MessageEnd {
                            message: message.clone(),
                        })
                        .await?;
                        current_context.messages.push(message.clone());
                        new_messages.push(message.clone());
                        emit(AgentEvent::TurnEnd {
                            message,
                            tool_results: Vec::new(),
                        })
                        .await?;
                        emit(AgentEvent::AgentEnd {
                            messages: new_messages.clone(),
                        })
                        .await?;
                        return Ok(());
                    }
                    // A session gate stopped the next model request: the run
                    // closes without a failure row and the caller gets the reason.
                    Err(error) if error.downcast_ref::<super::InputRejected>().is_some() => {
                        emit(AgentEvent::AgentEnd {
                            messages: new_messages.clone(),
                        })
                        .await?;
                        return Err(error);
                    }
                    Err(error) => return Err(error),
                }
            }

            let message =
                stream_assistant_response(current_context, config, signal, emit, stream_fn).await?;
            new_messages.push(AgentMessage::from(message.clone()));

            if message.stop_reason == StopReason::Error
                || message.stop_reason == StopReason::Aborted
            {
                emit(AgentEvent::TurnEnd {
                    message: AgentMessage::from(message.clone()),
                    tool_results: Vec::new(),
                })
                .await?;
                emit(AgentEvent::AgentEnd {
                    messages: new_messages.clone(),
                })
                .await?;
                return Ok(());
            }

            let tool_calls = message
                .tool_calls()
                .into_iter()
                .cloned()
                .collect::<Vec<ToolCall>>();

            let mut tool_results: Vec<ToolResultMessage> = Vec::new();
            has_more_tool_calls = false;
            if !tool_calls.is_empty() {
                let executed_tool_batch =
                    execute_tool_calls(current_context, &message, config, signal, emit).await?;
                tool_results.extend(executed_tool_batch.messages);
                has_more_tool_calls = !executed_tool_batch.terminate;

                for result in &tool_results {
                    current_context
                        .messages
                        .push(AgentMessage::from(result.clone()));
                    new_messages.push(AgentMessage::from(result.clone()));
                }
            }

            emit(AgentEvent::TurnEnd {
                message: AgentMessage::from(message.clone()),
                tool_results: tool_results.clone(),
            })
            .await?;
            if signal.is_some_and(AbortSignal::is_aborted) {
                emit(AgentEvent::AgentEnd {
                    messages: new_messages.clone(),
                })
                .await?;
                return Ok(());
            }
            last_turn = Some(ShouldStopAfterTurnContext {
                message: message.clone(),
                tool_results: tool_results.clone(),
                context: clone_context(current_context),
                new_messages: new_messages.clone(),
            });

            let should_stop_result = settle_post_turn(
                race_with_abort(
                    async {
                        match config.should_stop_after_turn.as_ref() {
                            Some(hook) => hook(last_turn.clone().unwrap()).await,
                            None => Ok(false),
                        }
                    },
                    signal,
                ),
                signal,
            )
            .await?;
            match should_stop_result {
                PostTurnResult::Aborted | PostTurnResult::Completed(true) => {
                    emit(AgentEvent::AgentEnd {
                        messages: new_messages.clone(),
                    })
                    .await?;
                    return Ok(());
                }
                PostTurnResult::Completed(false) => {}
            }
            if should_stop_before_turn!() {
                emit(AgentEvent::AgentEnd {
                    messages: new_messages.clone(),
                })
                .await?;
                return Ok(());
            }

            let steering_messages_result = settle_post_turn(
                async {
                    let polled =
                        poll_messages_unless_aborted(config.get_steering_messages.as_ref(), signal)
                            .await?;
                    admit_batch(polled, config, signal).await
                },
                signal,
            )
            .await?;
            match steering_messages_result {
                PostTurnResult::Aborted => {
                    emit(AgentEvent::AgentEnd {
                        messages: new_messages.clone(),
                    })
                    .await?;
                    return Ok(());
                }
                PostTurnResult::Completed(messages) => {
                    pending_messages = messages;
                    // Steering drained by this poll owns the turn boundary;
                    // stop only when it was empty.
                    if pending_messages.is_empty() && should_stop_before_turn!() {
                        emit(AgentEvent::AgentEnd {
                            messages: new_messages.clone(),
                        })
                        .await?;
                        return Ok(());
                    }
                }
            }
        }

        if should_stop_before_turn!() {
            break;
        }
        let follow_up_messages_result = settle_post_turn(
            async {
                let polled =
                    poll_messages_unless_aborted(config.get_follow_up_messages.as_ref(), signal)
                        .await?;
                admit_batch(polled, config, signal).await
            },
            signal,
        )
        .await?;
        let follow_up_messages = match follow_up_messages_result {
            PostTurnResult::Aborted => {
                emit(AgentEvent::AgentEnd {
                    messages: new_messages.clone(),
                })
                .await?;
                return Ok(());
            }
            PostTurnResult::Completed(messages) => messages,
        };
        if !follow_up_messages.is_empty() {
            pending_messages = follow_up_messages;
            continue;
        }

        if should_stop_before_turn!() {
            break;
        }
        let continuation_result = match last_turn.clone() {
            Some(context) => {
                let continuation_op: crate::BoxFut<'static, anyhow::Result<Continuation>> =
                    match config.get_continuation_messages.as_ref() {
                        Some(hook) => hook(context, signal.cloned().unwrap_or_default()),
                        None => Box::pin(async { Ok(Continuation::NaturalStop) }),
                    };
                settle_post_turn(race_with_abort(continuation_op, signal), signal).await?
            }
            None => PostTurnResult::Completed(Continuation::Held),
        };
        let natural_stop = match continuation_result {
            PostTurnResult::Aborted => {
                emit(AgentEvent::AgentEnd {
                    messages: new_messages.clone(),
                })
                .await?;
                return Ok(());
            }
            PostTurnResult::Completed(Continuation::Messages(messages)) if !messages.is_empty() => {
                pending_messages = messages;
                continue;
            }
            PostTurnResult::Completed(Continuation::Messages(_) | Continuation::Held) => false,
            PostTurnResult::Completed(Continuation::NaturalStop) => true,
        };

        // Only a natural stop reaches the final Stop hook: a held boundary
        // belongs to the host's own pending work.
        if let (true, Some(final_stop), Some(context)) =
            (natural_stop, &config.final_stop, &last_turn)
        {
            // Stop commands can run for minutes, so an abort here is a
            // normal action: it ends the finished run cleanly.
            let boundary = settle_post_turn(
                async {
                    let continuation = race_with_abort(
                        final_stop(
                            context.message.clone(),
                            stop_hook_active,
                            signal.cloned().unwrap_or_default(),
                        ),
                        signal,
                    )
                    .await?;
                    crate::abort::throw_if_aborted_signal(signal)?;
                    // Commands may take time. Input that arrived meanwhile
                    // still owns the boundary before a hook continuation.
                    if should_stop_before_turn!() {
                        return Ok(StopBoundary::Finish);
                    }
                    let mut arrived =
                        poll_messages_unless_aborted(config.get_steering_messages.as_ref(), signal)
                            .await?;
                    if arrived.is_empty() {
                        arrived = poll_messages_unless_aborted(
                            config.get_follow_up_messages.as_ref(),
                            signal,
                        )
                        .await?;
                    }
                    let arrived = admit_batch(arrived, config, signal).await?;
                    if !arrived.is_empty() {
                        return Ok(StopBoundary::Input(arrived));
                    }
                    if stop_hook_active || continuation.is_empty() {
                        return Ok(StopBoundary::Finish);
                    }
                    // Hook feedback is a new user submission; autonomous and
                    // goal continuations above keep their internal provenance.
                    let continuation = admit_batch(continuation, config, signal).await?;
                    Ok(if continuation.is_empty() {
                        StopBoundary::Finish
                    } else {
                        StopBoundary::Continuation(continuation)
                    })
                },
                signal,
            )
            .await?;
            match boundary {
                PostTurnResult::Aborted | PostTurnResult::Completed(StopBoundary::Finish) => {}
                PostTurnResult::Completed(StopBoundary::Input(messages)) => {
                    pending_messages = messages;
                    continue;
                }
                PostTurnResult::Completed(StopBoundary::Continuation(messages)) => {
                    stop_hook_active = true;
                    pending_messages = messages;
                    continue;
                }
            }
        }

        break;
    }

    emit(AgentEvent::AgentEnd {
        messages: new_messages.clone(),
    })
    .await?;
    Ok(())
}

/// What the natural-stop boundary decided after the Stop hook.
enum StopBoundary {
    Finish,
    /// Submitted input that arrived while the hook ran.
    Input(Vec<AgentMessage>),
    /// Admitted hook feedback for one more turn.
    Continuation(Vec<AgentMessage>),
}

/// Pass a submitted batch through the input gate. A vetoed batch is dropped
/// (the gate already reported it); any other gate error propagates.
async fn admit_batch(
    messages: Vec<AgentMessage>,
    config: &AgentLoopConfig,
    signal: Option<&AbortSignal>,
) -> anyhow::Result<Vec<AgentMessage>> {
    if messages.is_empty() {
        return Ok(messages);
    }
    match before_input_batch(&messages, config, signal).await {
        Ok(()) => Ok(messages),
        Err(error) if error.downcast_ref::<super::InputRejected>().is_some() => Ok(Vec::new()),
        Err(error) => Err(error),
    }
}

pub(crate) async fn before_input_batch(
    messages: &[AgentMessage],
    config: &AgentLoopConfig,
    signal: Option<&AbortSignal>,
) -> anyhow::Result<()> {
    if let Some(before_input) = &config.before_input {
        race_with_abort(
            before_input(
                messages.to_vec(),
                config.model.clone(),
                signal.cloned().unwrap_or_default(),
            ),
            signal,
        )
        .await?;
    }
    Ok(())
}

pub(crate) fn clone_context(context: &AgentContext) -> AgentContext {
    AgentContext {
        system_prompt: context.system_prompt.clone(),
        messages: context.messages.clone(),
        tools: context.tools.clone(),
    }
}
