//! Owner-to-bot messages: at most once through the bot ledger.

use anyhow::anyhow;
use pa_types::daemon::DaemonCommand;
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

/// Send `message` to the bot session `guest_session_id` as `msg_id`.
/// The ledger row is `sending` before the first byte leaves and `sent`
/// only after the guest's receipt. Every other outcome leaves the row
/// `uncertain`; nothing here retries.
///
/// # Errors
///
/// Returns [`SendError::NotDelivered`] when the ledger refuses the id or
/// the guest refuses the message, and [`SendError::Uncertain`] when the
/// link fails after the send began.
pub async fn send_message(
    ledger: &BotLedger,
    client: &mut GuestClient,
    guest_session_id: &str,
    msg_id: &str,
    message: &str,
    delivery_mode: Option<Value>,
) -> Result<Value, SendError> {
    ledger
        .begin_message(msg_id)
        .map_err(SendError::NotDelivered)?;
    let command = DaemonCommand::SendMessage {
        id: None,
        target_active_session_id: guest_session_id.to_string(),
        message: message.to_string(),
        from_active_session_id: None,
        agent_origin: None,
        delivery_mode,
        rest: Map::default(),
    };
    let outcome = client.command(&command).await;
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
        Err(CommandError::Refused(error)) => Err(SendError::NotDelivered(anyhow!(error))),
        Err(CommandError::NoResponse(error)) => Err(SendError::Uncertain(error)),
    }
}
