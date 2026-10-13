//! The RPC prompt-family handlers: `prompt` (with the session-command
//! execution the admitted turn hands back), `steer`/`follow_up`
//! queueing, and the queued-work pump that delivers the agent's queues turn by turn.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde_json::Value;

use pa_agent::types::AgentEvent;
use pa_agent::types::AgentMessage;
use pa_core::session_engine::session_commands::{
    execute_session_command, session_command_echo_row, SessionCommandParams,
};
use pa_core::session_engine::session_events::agent_event_json;
use pa_core::session_engine::{PromptOptions, PromptOutcome};
use pa_types::session::CustomMessage;

use super::commands::{compaction_frame, kick_queue_pump, resume_pump, RpcState};
use super::protocol::{self, ResponseData};

/// `prompt`: admission-level success — the response fires once the admitted turn's run registers;
/// the events follow buffered behind it. Session commands execute like the ACP prompt path.
///
/// # Errors
/// Returns the admission error (a missing message, a refused turn) and the admitted session
/// command's own error.
pub async fn prompt(state: &Arc<RpcState>, payload: &Value) -> Result<ResponseData, String> {
    let message = payload
        .get("message")
        .and_then(Value::as_str)
        .ok_or_else(|| "prompt requires a message".to_string())?;
    let images = protocol::command_images(payload);
    let behavior = protocol::command_streaming_behavior(payload);
    let handle = state.session.handle().await;
    let engine = handle.engine.clone();
    let admission = engine
        .session
        .prompt_with_images(
            message,
            images,
            PromptOptions {
                streaming_behavior: behavior,
                return_after_accepted: true,
                ..PromptOptions::default()
            },
        )
        .await
        .map_err(|error| format!("{error:#}"))?;
    resume_pump(state);
    let PromptOutcome::SessionCommand(command) = admission else {
        // The admitted model turn parks the queued rows behind it (the
        // pump delivers when the session idles).
        kick_queue_pump(state, &engine);
        return Ok(ResponseData::Absent);
    };
    // The handle guard stays held through the command's execution: a
    // replacement can never dispose the kernel mid-command. The model
    // and key pass THROUGH: a re-acquisition behind a waiting writer
    // would deadlock.
    let model = handle.model.clone();
    let api_key = handle.api_key.clone();
    let command_result =
        run_session_command(state.as_ref(), engine.clone(), &command, model, api_key).await;
    drop(handle);
    // The pump is scheduled only after the command settles: an earlier
    // kick would deliver parked rows into the rebuild's window.
    kick_queue_pump(state, &engine);
    command_result?;
    Ok(ResponseData::Absent)
}

/// One durable session-command row as its `message_start`/`message_end`
/// pair (the loop's event shape for persisted rows).
async fn write_command_row(state: &RpcState, message: &CustomMessage) {
    // The row's loop shape: the `custom` role rides BESIDE the row's
    // own fields (a bare round-trip cannot recover it, the session row
    // type carries no role).
    let custom = pa_agent::types::CustomAgentMessage {
        role: "custom".to_string(),
        payload: serde_json::to_value(message).unwrap_or(serde_json::Value::Null),
    };
    for event in [
        AgentEvent::MessageStart {
            message: AgentMessage::Custom(custom.clone()),
        },
        AgentEvent::MessageEnd {
            message: AgentMessage::Custom(custom),
        },
    ] {
        if let Some(event) = agent_event_json(&event) {
            state.session.write_connection_output(event).await;
        }
    }
}

/// Execute one session command the prompt admitted: the executor
/// persists the echo/result rows; the goal publishes on change.
async fn run_session_command(
    state: &RpcState,
    engine: Arc<pa_core::session_engine::engine::SessionEngine>,
    command: &pa_core::session_engine::slash_commands::SessionSlashCommand,
    model: pa_types::ai::Model,
    api_key: Option<String>,
) -> Result<(), String> {
    let is_compact = command.name == "compact";
    // The compact frames carry the command's arguments as the
    // `customInstructions` they compact under.
    let frame_instructions = if is_compact && !command.args.is_empty() {
        Some(command.args.as_str())
    } else {
        None
    };
    // The attempted command's durable echo row streams BEFORE the
    // execution, as a message pair on the event stream.
    write_command_row(state, &session_command_echo_row(command)).await;
    if is_compact {
        state.compacting.fetch_add(1, Ordering::SeqCst);
        // The direct compact command's contract: a turn streaming behind
        // the admission is aborted and drained BEFORE the start frame
        // publishes (the frame means the transcript is settled).
        engine.session.agent().abort();
        engine.session.agent().wait_for_idle().await;
        state
            .session
            .write_connection_output(compaction_frame(
                "compaction_start",
                frame_instructions,
                None,
            ))
            .await;
        // NO flush here, by TS parity: the prompt-response buffer is armed,
        // so this `compaction_start` publishes AFTER the prompt's response
        // (the direct `compact` handler flushes early).
    }
    let execution = {
        // The executor rebuilds session context on its compact branch:
        // serialize against the other context rebuilders.
        let _ops = state.session_ops.lock().await;
        let mut autonomous = state.autonomous.lock().await;
        let mut params = SessionCommandParams {
            model: &model,
            api_key: api_key.clone(),
            global_harness_dir: state.agent_dir.clone(),
            autonomous: &mut autonomous,
        };
        // The executor never errors out of the call: failures ride
        // `execution.error` and the session events.
        execute_session_command(&engine, &mut params, command).await
    };
    if is_compact {
        // The post-compaction kernel notice rides between the start and
        // the settled end (the ACP seam's order).
        if let Some(message) = execution
            .compaction
            .as_ref()
            .and_then(|compaction| compaction.ipython_state.as_ref())
        {
            write_command_row(state, message).await;
        }
        state.compacting.fetch_sub(1, Ordering::SeqCst);
        let result = execution.compaction.as_ref().map(|compaction| {
            crate::compaction::compaction_result_value(&compaction.result, &compaction.entry)
        });
        state
            .session
            .write_connection_output(compaction_frame(
                "compaction_end",
                frame_instructions,
                result.as_ref(),
            ))
            .await;
    }
    // The executor's first row is the echo (emitted above); the rest of
    // the durable rows stream in order.
    for message in execution.messages.iter().skip(1) {
        write_command_row(state, message).await;
    }
    // The handle guard is still held here: publishing over the held
    // engine's goal state avoids re-acquiring behind a queued writer.
    let goal = engine.goal_state().await;
    state.publish_goal_update_for(&goal).await;
    if let Some(error) = &execution.error {
        return Err(error.clone());
    }
    if let Some(continuation) = execution.continuation_message {
        engine
            .session
            .prompt_injected_message(&continuation)
            .await
            .map_err(|error| format!("{error:#}"))?;
        engine.session.agent().wait_for_idle().await;
    }
    Ok(())
}

/// `steer` / `follow_up`: queue onto the agent lane regardless of the busy state.
///
/// # Errors
///
/// Returns the missing-message error when the command carries no text.
pub async fn steer_or_follow_up(
    state: &Arc<RpcState>,
    payload: &Value,
    name: &str,
) -> Result<ResponseData, String> {
    let message = payload
        .get("message")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{name} requires a message"))?;
    let images = protocol::command_images(payload);
    let handle = state.session.handle().await;
    let engine = handle.engine.clone();
    let agent = engine.session.agent();
    let batch = user_prompt_message(message, &images);
    if name == "steer" {
        agent.steer(batch);
    } else {
        agent.follow_up(batch);
    }
    // A steer/follow-up command is a TS pump-resume site: queued input
    // (including the one just queued) delivers when the session idles.
    resume_pump(state);
    kick_queue_pump(state, &engine);
    Ok(ResponseData::Absent)
}

/// The user prompt message in the loop's normalized shape (text part first, image parts after).
fn user_prompt_message(text: &str, images: &[pa_agent::types::ImageContent]) -> AgentMessage {
    let mut parts = vec![pa_agent::types::UserPart::Text(
        pa_agent::types::TextContent {
            text: text.to_string(),
            text_signature: None,
        },
    )];
    for image in images {
        parts.push(pa_agent::types::UserPart::Image(image.clone()));
    }
    AgentMessage::Standard(pa_agent::types::Message::User(
        pa_agent::types::UserMessage {
            content: pa_agent::types::UserContent::Parts(parts),
            timestamp: now_millis() as i64,
        },
    ))
}
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}
