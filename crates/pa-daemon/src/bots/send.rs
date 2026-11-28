//! Owner-to-bot messages: at most once, as nothing resends a message.

use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::anyhow;
use pa_types::daemon::{DaemonCommand, PromptInput};
use serde_json::{Map, Value};

use super::guest::{CommandError, GuestClient};

/// Why a message did not reach the bot.
#[derive(Debug)]
pub enum SendError {
    /// The bot did not get the message.
    NotDelivered(anyhow::Error),
    /// The bot may have the message; it is never resent.
    Uncertain(anyhow::Error),
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotDelivered(error) => write!(f, "{error:#}"),
            Self::Uncertain(error) => write!(
                f,
                "delivery is uncertain: {error:#}. The bot may or may not have the message; it is not resent"
            ),
        }
    }
}

/// Run one whole send (wake, link, and [`send_message`]) under
/// `deadline`. The caller sets `began` just before the message leaves: a
/// send cut off after that may have landed.
///
/// # Errors
///
/// Returns the send's own error, [`SendError::Uncertain`] when the
/// deadline cut a begun send, and [`SendError::NotDelivered`] when it
/// cut the send before it began.
pub async fn send_within<T>(
    began: &AtomicBool,
    deadline: std::time::Duration,
    send: impl std::future::Future<Output = Result<T, SendError>>,
) -> Result<T, SendError> {
    let Ok(outcome) = tokio::time::timeout(deadline, send).await else {
        let expired = anyhow!("the bot did not answer within {deadline:?}");
        return Err(if began.load(Ordering::SeqCst) {
            SendError::Uncertain(expired)
        } else {
            SendError::NotDelivered(expired)
        });
    };
    outcome
}

/// Send `message` to the bot session `guest_session_id`. Nothing here
/// retries.
///
/// # Errors
///
/// Returns [`SendError::NotDelivered`] when the command never left, and
/// [`SendError::Uncertain`] when the guest fails the command or the link
/// fails after the send began.
pub async fn send_message(
    client: &mut GuestClient,
    guest_session_id: &str,
    message: &str,
    delivery_mode: Option<Value>,
) -> Result<Value, SendError> {
    let command = DaemonCommand::SendMessage {
        id: None,
        target_active_session_id: guest_session_id.to_string(),
        message: message.to_string(),
        from_active_session_id: None,
        agent_origin: None,
        delivery_mode,
        rest: Map::default(),
    };
    send_once(client, &command).await
}

/// Prompt the bot session `guest_session_id` with its task, like
/// [`send_message`]. The task is the session's user prompt, so the model
/// reads it without an inbox read, like a local child's task.
///
/// # Errors
///
/// As [`send_message`].
pub async fn send_task(
    client: &mut GuestClient,
    guest_session_id: &str,
    task: &str,
) -> Result<Value, SendError> {
    let command = DaemonCommand::Prompt {
        id: None,
        active_session_id: guest_session_id.to_string(),
        message: format!("[task from parent]\n\n{task}"),
        input: PromptInput {
            content: None,
            images: None,
            streaming_behavior: None,
            queue_if_busy: None,
            expand_prompt_templates: None,
            source: Some(Value::from("rpc")),
            agent_message_id: None,
            custom_message: None,
            queue_key: None,
            prefix_messages: None,
            admission_id: None,
            rlm_notice_nonce: None,
        },
        rest: Map::default(),
    };
    send_once(client, &command).await
}

async fn send_once(client: &mut GuestClient, command: &DaemonCommand) -> Result<Value, SendError> {
    match client.command(command).await {
        Ok(receipt) => Ok(receipt),
        Err(CommandError::NotSent(error)) => Err(SendError::NotDelivered(error)),
        // A guest may fail the command after its worker took the message.
        Err(CommandError::Refused(error)) => Err(SendError::Uncertain(anyhow!(error))),
        Err(CommandError::NoResponse(error)) => Err(SendError::Uncertain(error)),
    }
}
