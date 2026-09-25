//! The RPC command surface, part two: the prompt-family handlers —
//! `prompt` (with the session-command execution the admitted turn hands
//! back), `steer`/`follow_up` queueing, and the queued-work pump that
//! delivers the agent's queues turn by turn (TS `prompt`/`steer`/
//! `followUp` over `_pumpSessionInputs`).

use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde_json::Value;

use pa_agent::types::AgentMessage;
use pa_core::session_engine::session_commands::{execute_session_command, SessionCommandParams};
use pa_core::session_engine::{PromptOptions, PromptOutcome, StreamingBehavior};

use super::commands::{compaction_frame, kick_queue_pump, resume_pump, RpcState};
use super::protocol::{self, ResponseData};

/// The streaming behavior of a prompt command (TS `"steer"`/`"followUp"`).
fn command_streaming_behavior(payload: &Value) -> Option<StreamingBehavior> {
    match payload.get("streamingBehavior").and_then(Value::as_str) {
        Some("steer") => Some(StreamingBehavior::Steer),
        Some("followUp") => Some(StreamingBehavior::FollowUp),
        _ => None,
    }
}

/// `prompt` (TS `connection.prompt(message, {images, streamingBehavior,
/// source: "rpc"})`): admission-level success — the turn's events follow
/// on the ordered stream. Session commands execute like the ACP prompt
/// path (the pa-core executor persists the durable rows).
///
/// # Errors
///
/// Returns the admission error (a missing message, a refused turn) and
/// the admitted session command's own error.
pub async fn prompt(state: &Arc<RpcState>, payload: &Value) -> Result<ResponseData, String> {
    let message = payload
        .get("message")
        .and_then(Value::as_str)
        .ok_or_else(|| "prompt requires a message".to_string())?;
    let images = protocol::command_images(payload);
    let behavior = command_streaming_behavior(payload);
    let handle = state.session.handle().await;
    let engine = handle.engine.clone();
    let admission = engine
        .session
        .prompt_with_images(
            message,
            images,
            PromptOptions {
                streaming_behavior: behavior,
                ..PromptOptions::default()
            },
        )
        .await
        .map_err(|error| format!("{error:#}"))?;
    resume_pump(state);
    kick_queue_pump(state, &engine);
    let PromptOutcome::SessionCommand(command) = admission else {
        return Ok(ResponseData::Absent);
    };
    // The handle guard stays held through the admitted session command's
    // execution: a concurrent whole-session replacement (whose swap
    // waits on the write guard) can never dispose the kernel mid-command
    // (TS runs the admitted command before the next queued line can
    // start a replacement).
    run_session_command(state.as_ref(), engine, &command).await?;
    drop(handle);
    Ok(ResponseData::Absent)
}

/// Execute one session command the prompt admitted (the ACP prompt path's
/// segment: the pa-core executor persists the echo/result rows, the
/// compaction publishes its events, the goal publishes on change, and a
/// goal start/resume continuation runs as the turn's model segment).
async fn run_session_command(
    state: &RpcState,
    engine: Arc<pa_core::session_engine::engine::SessionEngine>,
    command: &pa_core::session_engine::slash_commands::SessionSlashCommand,
) -> Result<(), String> {
    let (model, api_key) = {
        let handle = state.session.handle().await;
        (handle.model.clone(), handle.api_key.clone())
    };
    let is_compact = command.name == "compact";
    if is_compact {
        state.compacting.store(true, Ordering::SeqCst);
        state
            .session
            .write_connection_output(compaction_frame("compaction_start", None, None))
            .await;
    }
    let execution = {
        let mut autonomous = state.autonomous.lock().await;
        let mut params = SessionCommandParams {
            model: &model,
            api_key: api_key.clone(),
            global_harness_dir: state.agent_dir.clone(),
            autonomous: &mut autonomous,
        };
        // The executor never errors out of the call: failures ride the
        // execution (`execution.error`), the durable rows, and the
        // session events — the handler surfaces them below.
        execute_session_command(&engine, &mut params, command).await
    };
    if is_compact {
        state.compacting.store(false, Ordering::SeqCst);
        let result = execution.compaction.as_ref().map(|compaction| {
            crate::compaction::compaction_result_value(&compaction.result, &compaction.entry)
        });
        state
            .session
            .write_connection_output(compaction_frame("compaction_end", None, result.as_ref()))
            .await;
    }
    state.publish_goal_update().await;
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

/// `steer` / `follow_up` (TS `connection.steer/followUp(message, images)`):
/// queue onto the agent lane regardless of the busy state.
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

/// The user prompt message in the loop's normalized shape (text part
/// first, image parts after), the same shape a directly admitted prompt
/// carries (TS `AgentSession.steer`'s message build).
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
