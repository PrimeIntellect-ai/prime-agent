//! The prompt turn: admission, session-command execution, the autonomous
//! continuation loop, and the correlated settlement in front of the
//! response. One prompt turn at a time; the turn runs as its own task so
//! the reader loop can keep serving session/cancel and session/close.

use std::sync::Arc;

use serde_json::Value;
use tokio::sync::Mutex;

use pa_core::autonomous::{AgentAutonomousStatus, AutonomousFollowUp, AutonomousStopReason};
use pa_core::session_engine::session_commands::execute_session_command;
use pa_core::session_engine::session_commands::SessionCommandParams;
use pa_core::session_engine::{PromptOptions, PromptOutcome, StreamingBehavior};

use super::compaction_arms::{CompactionCheckRun, ThresholdGoalQueue};
use super::goal_continuation;
use super::internal_error;
use super::meta::{self, PrimeAgentAutonomousMeta, PrimeAgentEventPhase, PrimeAgentOutcome};
use super::session::{self, AcpSession, TurnBoundary};
use super::stop_reason_response;
use super::types::PromptParams;
use super::{events, jsonrpc, producer, AcpModeState, AcpStopReason, ConnectionState};

/// The `_meta.autonomous` accounting for a completion update: shared with
/// the daemon-attached settlement (meta.rs).
fn autonomous_meta(status: &AgentAutonomousStatus) -> PrimeAgentAutonomousMeta {
    meta::autonomous_meta(status)
}

pub(super) async fn handle_session_prompt(
    id: Value,
    params: Value,
    state: Arc<Mutex<ConnectionState>>,
    mode: AcpModeState,
    tx: producer::FrameSink,
) {
    let params = PromptParams::parse(&params);
    // Admission: one prompt turn at a time, behind any started cancellation.
    let (session, turn_id) = {
        let mut state = state.lock().await;
        let closing = state.session_close_in_flight;
        let Some(entry) = state.session.as_mut() else {
            let _ = tx.send(internal_error(
                &id,
                &format!("Unknown ACP session: {}", params.session_id),
            ));
            return;
        };
        if closing {
            let _ = tx.send(internal_error(
                &id,
                &format!("ACP session is closing: {}", params.session_id),
            ));
            return;
        }
        if entry.prompt_task.is_some() {
            let _ = tx.send(internal_error(
                &id,
                "A prompt turn is already running for this ACP session",
            ));
            return;
        }
        let turn_id = entry.session.producer().begin_prompt().await;
        (entry.session.clone(), turn_id)
    };
    if session.cancel_requested() {
        // This prompt was admitted after a cancellation started; it is
        // dropped by the cancel, so report the protocol stop reason instead
        // of a request error.
        session.producer().finish_prompt(turn_id).await;
        let _ = tx.send(jsonrpc::response(
            id,
            stop_reason_response(AcpStopReason::Cancelled),
        ));
        return;
    }

    let admitted_prompt = match session::AdmittedPrompt::parse(&params.prompt) {
        Ok(prompt) => prompt,
        Err(error) => {
            session.producer().finish_prompt(turn_id).await;
            let _ = tx.send(session::prompt_block_error(&id, error));
            return;
        }
    };

    // The turn runs as its own task so the reader loop can keep serving
    // session/cancel and session/close while it settles.
    let task = tokio::spawn(run_prompt_turn(
        id,
        params.session_id.clone(),
        turn_id,
        admitted_prompt,
        session,
        state.clone(),
        mode,
        tx.clone(),
    ));
    let mut state = state.lock().await;
    if let Some(entry) = state.session.as_mut() {
        if entry.session.id == params.session_id {
            entry.prompt_task = Some(task);
        }
    }
}

/// One prompt turn: admission into the engine (a model turn or a session
/// command), the autonomous continuation loop, and the correlated boundary /
/// completion envelope in front of the response.
#[allow(clippy::too_many_arguments)]
async fn run_prompt_turn(
    id: Value,
    session_id: String,
    turn_id: u64,
    admitted_prompt: session::AdmittedPrompt,
    session: Arc<AcpSession>,
    state: Arc<Mutex<ConnectionState>>,
    mode: AcpModeState,
    tx: producer::FrameSink,
) {
    let boundary = TurnBoundary::capture(mode.engine.session.agent()).await;
    // The pre-turn compaction arms (TS `_runPreTurnCompaction`,
    // `beforeModelSelection`): a stale overflow from the previous run
    // recovers on the newly admitted prompt, then a threshold crossing
    // compacts before the turn runs. Session commands never reach the
    // prompt commit in TS, so they never fire the arms; a busy agent
    // queues the prompt below without a session-level boundary (the
    // settled-turn check after the drain covers the turn).
    if mode
        .engine
        .session
        .classify_session_command(&admitted_prompt.text)
        .is_none()
    {
        let busy = mode.engine.session.agent().state().await.is_streaming;
        if !busy {
            session.run_pre_turn_compaction(&mode).await;
        }
    }
    let admission = mode
        .engine
        .session
        .prompt_with_images(
            &admitted_prompt.text,
            admitted_prompt
                .images
                .into_iter()
                .map(|image| pa_agent::types::ImageContent {
                    data: image.data,
                    mime_type: image.mime_type,
                })
                .collect(),
            PromptOptions {
                streaming_behavior: Some(StreamingBehavior::FollowUp),
                queue_if_busy: true,
                ..Default::default()
            },
        )
        .await;

    // The settled-turn outcome: the failure text (a failed turn errors the
    // request), the autonomous stop, and whether the turn ran at all.
    let mut turn_failure: Option<String> = None;
    let mut autonomous_stop: Option<(
        pa_core::autonomous::AutonomousStopReason,
        Box<AgentAutonomousStatus>,
    )> = None;
    let ran_model_turn;

    match admission {
        // Session commands (compact/refine/goal/autonomous) never admit a
        // model turn: the durable echo row replaces the user row. Execute
        // them and publish their namespaced events.
        Ok(PromptOutcome::SessionCommand(command)) => {
            match run_session_command_segment(&mode, &session, &command, &mut turn_failure).await {
                Ok(ran) => ran_model_turn = ran,
                Err(error) => {
                    // Command execution could not start (no resolved model):
                    // an admission-style error boundary, never an invented
                    // terminal-quiescence update.
                    let _ = session::publish_response_boundary(
                        &session,
                        turn_id,
                        false,
                        PrimeAgentOutcome::Error,
                    )
                    .await;
                    session.producer().finish_prompt(turn_id).await;
                    let _ = tx.send(internal_error(&id, &format!("{error:#}")));
                    clear_prompt_slot(&state, &session_id).await;
                    return;
                }
            }
        }
        Ok(PromptOutcome::Prompt) => {
            ran_model_turn = true;
        }
        Err(error) => {
            // Failed prompt admission gets one correlated error boundary; it
            // never gets an invented terminal-quiescence update.
            let _ = session::publish_response_boundary(
                &session,
                turn_id,
                false,
                PrimeAgentOutcome::Error,
            )
            .await;
            session.producer().finish_prompt(turn_id).await;
            let _ = tx.send(internal_error(&id, &format!("{error:#}")));
            clear_prompt_slot(&state, &session_id).await;
            return;
        }
    }

    if ran_model_turn {
        mode.engine.session.agent().wait_for_idle().await;
    }

    // The turn-settlement loop: classify each settled turn, run the
    // automatic compaction arms at its boundary (TS `_checkCompaction` at
    // `agent_end`), consume the requested refinement (TS
    // `_consumePendingRequestedRefine`), then ask the autonomous driver
    // what follows. A continuation runs as the next turn of the same
    // prompt, so every boundary in the run hosts its arms.
    loop {
        if session.cancel_requested() || !ran_model_turn {
            break;
        }
        let Some(final_message) =
            session::latest_assistant_message(mode.engine.session.agent()).await
        else {
            break;
        };
        // The newest assistant predates the turn: the turn appended
        // none, so there is nothing to classify.
        if boundary.contains_wire(&final_message) {
            break;
        }
        // An aborted turn never services its boundary requests (TS
        // `_checkCompaction`'s abort arm): drop the pending compaction
        // and refine requests, reset the overflow machine, and settle.
        if final_message.stop_reason == pa_types::ai::StopReason::Aborted {
            session.reset_overflow_recovery().await;
            session.clear_turn_boundary_requests(&mode.engine).await;
            break;
        }
        // A settled non-error assistant message resets the overflow
        // machine (TS resets `_overflowRecovery` at every non-error
        // assistant `message_end`) and counts into the auto-refine
        // review prompt's turn line (TS `_assistantTurnsSinceAutoRefine`'s
        // message_end increment), then the boundary check runs.
        if final_message.stop_reason != pa_types::ai::StopReason::Error {
            session.reset_overflow_recovery().await;
            mode.engine
                .session
                .note_settled_turn_since_auto_refine_review();
        }
        // TS `_checkCompaction` at `agent_end`: the overflow arm (Case 1,
        // with its compact-and-retry), then the requested arm (which
        // stops the run on purpose), then the threshold arm (which, under
        // the settled boundary's queue policy, mints the goal continuation
        // before it compacts — the held turn runs after the boundary like
        // the TS post-compaction continue).
        let (check, threshold_continuation) = session
            .check_compaction(&mode, &final_message, ThresholdGoalQueue::Queue)
            .await;
        if session.cancel_requested() {
            if threshold_continuation.is_some() {
                // A cancellation between the mint and the run withdraws
                // the queued continuation (the TS cancel clears the
                // queue and rolls the slot back).
                goal_continuation::rollback_goal_mint(&mode).await;
            }
            break;
        }
        if check == CompactionCheckRun::OverflowRetry {
            // The compacted context re-issues the turn without a new
            // user message (TS `agent.continue()`); the settled retry
            // re-enters this loop through its own boundary.
            if let Err(error) = mode.engine.session.agent().continue_run().await {
                turn_failure = Some(format!("{error:#}"));
                break;
            }
            mode.engine.session.agent().wait_for_idle().await;
            continue;
        }
        // TS consumes the requested refinement whenever the compaction
        // check did not report a will-retry (`_consumePendingRequestedRefine`
        // at `agent_end`), then the serialized checkpoint's compact step
        // services an armed compact-trigger review (autorefine.rs). The
        // compact-trigger round defers behind a held goal continuation
        // (TS `_scheduleAutoRefineAfterCompaction(willContinue)`): the
        // continuation turn's own boundary services it.
        session.consume_requested_refine(&mode).await;
        if threshold_continuation.is_none() {
            session.consume_compact_auto_refine(&mode).await;
        }
        // A failed turn ends the run with its error once the boundary
        // check could not save it (an overflow recovery that re-issued
        // handled it above).
        if final_message.stop_reason == pa_types::ai::StopReason::Error {
            // TS `_finishGoalForTerminalAssistantMessage` at `agent_end`:
            // the failed turn fails an active goal (the state change
            // publishes before the response settles).
            goal_continuation::fail_goal_for_terminal_error(
                &mode,
                &session,
                final_message.error_message.as_deref(),
            )
            .await;
            turn_failure = Some(
                final_message
                    .error_message
                    .clone()
                    .unwrap_or_else(|| "the model request failed".to_string()),
            );
            break;
        }
        // A requested compaction stops the run on purpose: the model
        // resumes on the next prompt.
        if check == CompactionCheckRun::RequestedStop {
            break;
        }
        // The threshold arm's held goal continuation runs as the
        // post-compaction turn (TS `_schedulePostCompactionContinue` over
        // the queued follow-up): the pre-turn compaction arms run before
        // it like any admitted prompt, and its own settled boundary
        // re-enters this loop.
        if let Some(message) = threshold_continuation {
            session.run_pre_turn_compaction(&mode).await;
            if let Err(error) = mode.engine.session.prompt_injected_message(&message).await {
                turn_failure = Some(format!("{error:#}"));
                break;
            }
            mode.engine.session.agent().wait_for_idle().await;
            continue;
        }
        if session.cancel_requested() {
            break;
        }
        // TS `_getContinuationMessages` at the agent loop's natural turn
        // end: the goal arm runs before the autonomous arm with exclusive
        // priority — the budget-limit wrap-up steer first (the turn that
        // crossed the goal budget), then the natural continuation mint
        // (an active goal mints one continuation per settled boundary).
        // A minted turn runs as the next turn of the same prompt (the
        // pre-turn compaction arms run before it like any admitted
        // prompt); no active goal falls through to the autonomous arm.
        match goal_continuation::goal_follow_up(&mode, &session).await {
            goal_continuation::GoalFollowUp::Turn(message) => {
                let message = *message;
                session.run_pre_turn_compaction(&mode).await;
                if let Err(error) = mode.engine.session.prompt_injected_message(&message).await {
                    turn_failure = Some(format!("{error:#}"));
                    break;
                }
                mode.engine.session.agent().wait_for_idle().await;
                continue;
            }
            goal_continuation::GoalFollowUp::None => {
                match session.autonomous_follow_up(&final_message).await {
                    AutonomousFollowUp::Inactive => break,
                    AutonomousFollowUp::Continue { text } => {
                        // An injected continuation runs as the next turn
                        // of the same prompt (a fresh user row: the
                        // pre-turn compaction arms run before it, like
                        // any admitted prompt); its failure settles the
                        // prompt.
                        session.run_pre_turn_compaction(&mode).await;
                        if let Err(error) = mode
                            .engine
                            .session
                            .prompt(
                                &text,
                                PromptOptions {
                                    streaming_behavior: Some(StreamingBehavior::FollowUp),
                                    queue_if_busy: true,
                                    ..Default::default()
                                },
                            )
                            .await
                        {
                            turn_failure = Some(format!("{error:#}"));
                            break;
                        }
                        mode.engine.session.agent().wait_for_idle().await;
                    }
                    AutonomousFollowUp::Stop { reason, status } => {
                        // The stop writes no row (the TS shape): the stop
                        // reason and status ride the completion update and
                        // the response's stop reason.
                        autonomous_stop = Some((reason, status));
                        break;
                    }
                }
            }
        }
    }

    settle_turn(
        &state,
        &session,
        &id,
        &session_id,
        turn_id,
        turn_failure,
        autonomous_stop,
        tx,
    )
    .await;
}

/// Execute one session command and publish its namespaced events:
/// compaction and refinement outcomes, plus any goal state change. A goal
/// start/resume schedules its continuation context as the turn's model
/// segment after the command settles.
async fn run_session_command_segment(
    mode: &AcpModeState,
    session: &Arc<AcpSession>,
    command: &pa_core::session_engine::slash_commands::SessionSlashCommand,
    turn_failure: &mut Option<String>,
) -> anyhow::Result<bool> {
    let Some(model) = mode.current_model().await else {
        // Unreachable in practice (the engine assembly requires a model);
        // fail as a request error instead of a turn failure.
        anyhow::bail!("No model available to run the session command");
    };
    // The autonomous guard scopes tightly around the executor call: a
    // scheduled continuation prompts the model below, and the event
    // listener's per-message accounting must be able to take the same
    // mutex while that turn runs.
    let execution = {
        let mut autonomous = session.autonomous.lock().await;
        let mut params = SessionCommandParams {
            model: &model,
            api_key: mode.current_api_key().await,
            global_harness_dir: mode.agent_dir.as_path().to_path_buf(),
            autonomous: &mut autonomous,
        };
        execute_session_command(&mode.engine, &mut params, command).await
    };

    // A compaction publishes its namespaced event whether it ran (result
    // fields present) or skipped (the TS compaction_end with an undefined
    // result): the skip is observable, not silent.
    let compaction_event = if command.name == "compact" {
        Some(match &execution.compaction {
            Some(compaction) => events::AcpEngineEvent::CompactionEnd {
                tokens_before: Some(compaction.result.tokens_before),
                summary: Some(compaction.result.summary.clone()),
            },
            None => events::AcpEngineEvent::CompactionEnd {
                tokens_before: None,
                summary: None,
            },
        })
    } else {
        None
    };
    if let Some(event) = compaction_event {
        publish_engine_event(session, &event).await;
    }
    // TS `compact()` schedules the compact-trigger auto-refine review
    // after every successful compaction: a session command never runs a
    // turn, so the armed trigger waits for the next serialized checkpoint
    // or the session-close drain (autorefine.rs).
    if command.name == "compact" && execution.compaction.is_some() {
        mode.engine.session.mark_compact_auto_refine_pending();
        // TS `compact()`'s `didCompact` + active-goal finally arm: a
        // successful manual compact with an active goal mints the owed
        // continuation (the `||= !hasQueuedMessages()` arm — the direct
        // ACP never queues work behind a session command) and the
        // continuation runs as the turn's model segment, the scheduled
        // continue over the queued follow-up. The compact-trigger review
        // defers behind it (the continuation turn's boundary services
        // it, like the goal-start segment below).
        if let Some(message) = goal_continuation::mint_goal_continuation(mode, session).await {
            return run_goal_continuation_segment(mode, session, message, turn_failure).await;
        }
    }

    // Refinement outcomes publish complete/failed events; option-parse
    // failures are command failures without a refinement event.
    if let Some(result) = &execution.refinement {
        publish_engine_event(
            session,
            &events::AcpEngineEvent::RefineComplete {
                summary: result.summary.clone(),
                changes: result
                    .applied_edits
                    .iter()
                    .filter(|edit| edit.applied)
                    .map(|edit| {
                        let action = serde_json::to_value(edit.action)
                            .ok()
                            .and_then(|value| value.as_str().map(str::to_string))
                            .unwrap_or_default();
                        let kind = serde_json::to_value(edit.kind)
                            .ok()
                            .and_then(|value| value.as_str().map(str::to_string))
                            .unwrap_or_default();
                        format!("{action} {kind}:{}", edit.id)
                    })
                    .collect(),
            },
        )
        .await;
    }
    if let Some(error) = &execution.refinement_failed {
        publish_engine_event(
            session,
            &events::AcpEngineEvent::RefineFailed {
                error: error.clone(),
            },
        )
        .await;
    }

    // Any goal state change (start/status/clear/pause/resume) publishes.
    session.publish_goal_update().await;

    // A scheduled goal continuation runs as the turn's model segment; its
    // settled turn participates in the settle loop like any model turn.
    if let Some(message) = execution.continuation_message {
        return run_goal_continuation_segment(mode, session, message, turn_failure).await;
    }
    Ok(false)
}

/// Run one goal-continuation segment (a goal-context row minted by the
/// goal commands or the compact-with-active-goal continue) as the turn's
/// model segment: the pre-turn compaction arms run before it like any
/// admitted prompt (TS `_runPreTurnCompaction`), the injected custom row
/// is the turn's one representation (TS's prepared-turn primary record),
/// and the settled turn's boundary re-enters the settle loop.
async fn run_goal_continuation_segment(
    mode: &AcpModeState,
    session: &Arc<AcpSession>,
    message: pa_types::session::CustomMessage,
    turn_failure: &mut Option<String>,
) -> anyhow::Result<bool> {
    session.run_pre_turn_compaction(mode).await;
    if let Err(error) = mode.engine.session.prompt_injected_message(&message).await {
        *turn_failure = Some(format!("{error:#}"));
        return Ok(false);
    }
    mode.engine.session.agent().wait_for_idle().await;
    Ok(true)
}

/// Publish one adapter event through the session producer at the active
/// turn.
async fn publish_engine_event(session: &Arc<AcpSession>, event: &events::AcpEngineEvent) {
    let turn_id = session.producer().active_prompt_turn().await;
    let mut mapping = events::MappingState::default();
    let updates = events::acp_updates_for_event(event, &mut mapping);
    for update in updates {
        session
            .producer()
            .publish(&update, turn_id, PrimeAgentEventPhase::Event, None)
            .await;
    }
}

/// Settle one finished turn: the correlated boundary envelope, the response,
/// and the slot bookkeeping. The autonomous status rides the completion
/// update while a run is enabled, and the stop reason maps the driver's
/// stop outcome (`max_tokens` for token exhaustion, `max_turn_requests`
/// for every other limit, `end_turn` otherwise).
#[allow(clippy::too_many_arguments)]
async fn settle_turn(
    state: &Arc<Mutex<ConnectionState>>,
    session: &Arc<AcpSession>,
    id: &Value,
    session_id: &str,
    turn_id: u64,
    turn_failure: Option<String>,
    autonomous_stop: Option<(
        pa_core::autonomous::AutonomousStopReason,
        Box<AgentAutonomousStatus>,
    )>,
    tx: producer::FrameSink,
) {
    if session.cancel_requested() {
        // A cancellation before the response boundary resolves the request
        // with the protocol stop reason and no boundary frames.
        session.producer().finish_prompt(turn_id).await;
        let _ = tx.send(jsonrpc::response(
            id.clone(),
            stop_reason_response(AcpStopReason::Cancelled),
        ));
        clear_prompt_slot(state, session_id).await;
        return;
    }

    let outcome = if turn_failure.is_some() {
        PrimeAgentOutcome::Error
    } else {
        PrimeAgentOutcome::Result
    };
    // The response boundary precedes the correlated response; the completion
    // event and terminal quiescence envelope follow it in publication order.
    if session::publish_response_boundary(session, turn_id, true, outcome)
        .await
        .is_err()
    {
        session.producer().finish_prompt(turn_id).await;
        let _ = tx.send(internal_error(
            id,
            "Failed to publish ACP response boundary",
        ));
        clear_prompt_slot(state, session_id).await;
        return;
    }

    // The completion update carries the autonomous accounting while a run
    // is enabled (the stop status when the driver stopped the run, the live
    // snapshot otherwise).
    let autonomous_status = match &autonomous_stop {
        Some((_, status)) => Some((**status).clone()),
        None => {
            let status = session.autonomous_status().await;
            status.enabled.then_some(status)
        }
    };
    let autonomous_meta = autonomous_status.as_ref().map(autonomous_meta);
    // The remaining continuation slots the quiescence observation reports:
    // the configured budget minus what the run consumed (zero when no
    // autonomous run is active).
    let remaining_continuations = autonomous_status
        .as_ref()
        .map(|status| {
            status
                .limits
                .max_continuations
                .saturating_sub(status.continuations_used)
        })
        .unwrap_or(0);
    if session::publish_completion_envelope(
        session,
        turn_id,
        outcome,
        autonomous_meta.as_ref(),
        remaining_continuations,
    )
    .await
    .is_err()
    {
        session.producer().finish_prompt(turn_id).await;
        let _ = tx.send(internal_error(
            id,
            "Failed to publish ACP completion update",
        ));
        clear_prompt_slot(state, session_id).await;
        return;
    }

    session.producer().finish_prompt(turn_id).await;
    let stop_reason = match autonomous_stop.as_ref().map(|(reason, _)| reason) {
        None => AcpStopReason::EndTurn,
        Some(AutonomousStopReason::Limit(
            pa_core::autonomous::AutonomousLimitReason::MaxTokens,
        )) => AcpStopReason::MaxTokens,
        Some(AutonomousStopReason::Limit(_)) => AcpStopReason::MaxTurnRequests,
        Some(AutonomousStopReason::GatePassed | AutonomousStopReason::GateRetryExhausted) => {
            AcpStopReason::EndTurn
        }
    };
    let response = match turn_failure {
        Some(failure) => internal_error(id, &format!("prime-agent turn failed: {failure}")),
        None => jsonrpc::response(id.clone(), stop_reason_response(stop_reason)),
    };
    let _ = tx.send(response);
    clear_prompt_slot(state, session_id).await;
}

/// The running turn released the prompt slot; close/EOF no longer awaits it.
async fn clear_prompt_slot(state: &Arc<Mutex<ConnectionState>>, session_id: &str) {
    let mut state = state.lock().await;
    if let Some(entry) = state.session.as_mut() {
        if entry.session.id == session_id {
            entry.prompt_task = None;
        }
    }
}
