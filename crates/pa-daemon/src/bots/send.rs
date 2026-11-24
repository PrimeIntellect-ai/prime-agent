//! Owner-to-bot messages: at most once through the bot ledger.

use anyhow::anyhow;
use pa_types::daemon::{DaemonCommand, PromptInput};
use serde_json::{Map, Value};

use super::guest::{CommandError, GuestClient};
use super::ledger::{BotLedger, MessageState};

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

/// Run one whole send (wake, link, and [`send_message`] as `msg_id`)
/// under `deadline`. A send cut off after its `sending` row is durable
/// may have landed, so the row becomes `uncertain`; it is never resent.
///
/// # Errors
///
/// Returns the send's own error, [`SendError::Uncertain`] when the
/// deadline cut a begun send, and [`SendError::NotDelivered`] when it
/// cut the send before the ledger row.
pub async fn send_within<T>(
    ledger: &BotLedger,
    msg_id: &str,
    deadline: std::time::Duration,
    send: impl std::future::Future<Output = Result<T, SendError>>,
) -> Result<T, SendError> {
    let Ok(outcome) = tokio::time::timeout(deadline, send).await else {
        let expired = anyhow!("the bot did not answer within {deadline:?}");
        return match ledger.message_state(msg_id) {
            Ok(Some(MessageState::Sending)) => {
                // A failed write leaves the row `sending`; boot recovery
                // turns it `uncertain`.
                let _ = ledger.finish_message(msg_id, MessageState::Uncertain);
                Err(SendError::Uncertain(expired))
            }
            Ok(Some(MessageState::Sent | MessageState::Uncertain) | None) => {
                Err(SendError::NotDelivered(expired))
            }
            Err(error) => Err(SendError::Uncertain(error.context(expired))),
        };
    };
    outcome
}

/// Send `message` to the bot session `guest_session_id` as `msg_id`.
/// The ledger row is `sending` before the first byte leaves and `sent`
/// only after the guest's receipt. Every other outcome leaves the row
/// `uncertain`; nothing here retries.
///
/// # Errors
///
/// Returns [`SendError::NotDelivered`] when the ledger refuses the id or
/// the command never left, and [`SendError::Uncertain`] when the guest
/// fails the command or the link fails after the send began.
pub async fn send_message(
    ledger: &BotLedger,
    client: &mut GuestClient,
    guest_session_id: &str,
    msg_id: &str,
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
    send_once(ledger, client, msg_id, &command).await
}

/// Prompt the bot session `guest_session_id` with its task as `msg_id`,
/// under the same at-most-once ledger rules as [`send_message`]. The task
/// is the session's user prompt, so the model reads it without an inbox
/// read, like a local child's task.
///
/// # Errors
///
/// As [`send_message`].
pub async fn send_task(
    ledger: &BotLedger,
    client: &mut GuestClient,
    guest_session_id: &str,
    msg_id: &str,
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
    send_once(ledger, client, msg_id, &command).await
}

async fn send_once(
    ledger: &BotLedger,
    client: &mut GuestClient,
    msg_id: &str,
    command: &DaemonCommand,
) -> Result<Value, SendError> {
    ledger
        .begin_message(msg_id)
        .map_err(SendError::NotDelivered)?;
    let outcome = client.command(command).await;
    let state = if outcome.is_ok() {
        MessageState::Sent
    } else {
        MessageState::Uncertain
    };
    // A failed outcome write leaves the row `sending`; boot recovery
    // turns it `uncertain`. The receipt still stands.
    let _ = ledger.finish_message(msg_id, state);
    match outcome {
        Ok(receipt) => Ok(receipt),
        Err(CommandError::NotSent(error)) => Err(SendError::NotDelivered(error)),
        // A guest may fail the command after its worker took the message.
        Err(CommandError::Refused(error)) => Err(SendError::Uncertain(anyhow!(error))),
        Err(CommandError::NoResponse(error)) => Err(SendError::Uncertain(error)),
    }
}
