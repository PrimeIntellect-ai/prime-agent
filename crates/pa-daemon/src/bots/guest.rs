//! The supervisor's request/response client for a bot's guest daemon:
//! the normal daemon protocol over the relayed link.

use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use pa_types::daemon::{
    DaemonCommand, DaemonCommandEnvelope, DaemonCommandFrameType, DaemonProtocolInfo,
    DAEMON_PROTOCOL_NAME, DAEMON_PROTOCOL_VERSION, MAX_BOT_FRAME_BYTES,
};
use pa_types::platform::transport::{AsyncReadHalf, AsyncWriteHalf, TransportStream};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use super::{BotManager, BotRecord};

/// Budget for the guest daemon's hello after the link opens.
const HELLO_TIMEOUT: Duration = Duration::from_secs(30);
/// Budget for one command's response.
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
/// The client id the guest daemon sees for the owner's commands.
const CLIENT_ID: &str = "prime-agent-bot-owner";

/// The outcome class of a failed [`GuestClient::command`].
#[derive(Debug)]
pub enum CommandError {
    /// Nothing reached the guest.
    NotSent(anyhow::Error),
    /// The command may have reached the guest, but no response came back.
    NoResponse(anyhow::Error),
    /// The guest answered with a failure.
    Refused(String),
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotSent(error) | Self::NoResponse(error) => write!(f, "{error:#}"),
            Self::Refused(error) => f.write_str(error),
        }
    }
}

impl std::error::Error for CommandError {}

/// One connection to a bot's guest daemon.
pub struct GuestClient {
    reader: BufReader<Box<dyn AsyncReadHalf>>,
    writer: Box<dyn AsyncWriteHalf>,
    next_id: u64,
}

impl GuestClient {
    /// Open the link to `record`'s guest daemon and check its version.
    ///
    /// # Errors
    ///
    /// Returns an error when the link cannot open, the hello does not
    /// arrive, or the guest runs a different prime-agent version (the
    /// error is then the upgrade message).
    pub async fn connect(manager: &BotManager, record: &BotRecord) -> Result<Self> {
        let stream = manager.open_link(record).await?;
        Self::over_stream(stream).await
    }

    /// Run the hello and the version check over an open stream.
    ///
    /// # Errors
    ///
    /// Same as [`Self::connect`], without the link step.
    pub async fn over_stream(stream: Box<dyn TransportStream>) -> Result<Self> {
        let (reader, writer) = stream.split();
        let mut reader = BufReader::new(reader);
        let hello = tokio::time::timeout(HELLO_TIMEOUT, async {
            loop {
                let frame = read_frame(&mut reader).await?;
                if frame.get("type").and_then(Value::as_str) == Some("daemon_hello") {
                    return Ok::<Value, anyhow::Error>(frame);
                }
            }
        })
        .await
        .map_err(|_| anyhow!("the bot did not answer the daemon handshake"))??;
        if hello.pointer("/protocol/name").and_then(Value::as_str) != Some(DAEMON_PROTOCOL_NAME) {
            bail!("the bot link does not speak the daemon protocol");
        }
        super::link::check_version(&hello).map_err(|mismatch| anyhow!("{mismatch}"))?;
        Ok(Self {
            reader,
            writer,
            next_id: 0,
        })
    }

    /// Send one command and wait for its response data.
    ///
    /// # Errors
    ///
    /// Returns a [`CommandError`] that says whether the command can have
    /// reached the guest.
    pub async fn command(&mut self, command: &DaemonCommand) -> Result<Value, CommandError> {
        self.next_id += 1;
        let id = format!("bot_{}", self.next_id);
        let envelope = DaemonCommandEnvelope {
            frame_type: DaemonCommandFrameType::Command,
            id: id.clone(),
            protocol: DaemonProtocolInfo {
                name: DAEMON_PROTOCOL_NAME.to_string(),
                version: DAEMON_PROTOCOL_VERSION,
            },
            client_id: Some(CLIENT_ID.to_string()),
            command: command.clone(),
        };
        let mut line = serde_json::to_vec(&envelope)
            .context("encode the bot command")
            .map_err(CommandError::NotSent)?;
        line.push(b'\n');
        // From the first written byte on, the guest can have the command,
        // so the budget covers the write as well as the response.
        let response = tokio::time::timeout(COMMAND_TIMEOUT, async {
            self.writer.write_all(&line).await?;
            self.writer.flush().await?;
            loop {
                let frame = read_frame(&mut self.reader).await?;
                if frame.get("type").and_then(Value::as_str) == Some("response")
                    && frame.get("id").and_then(Value::as_str) == Some(id.as_str())
                {
                    return Ok::<Value, anyhow::Error>(frame);
                }
            }
        })
        .await
        .map_err(|_| CommandError::NoResponse(anyhow!("the bot did not answer in time")))?
        .map_err(CommandError::NoResponse)?;
        if response.get("success").and_then(Value::as_bool) == Some(true) {
            Ok(response.get("data").cloned().unwrap_or(Value::Null))
        } else {
            Err(CommandError::Refused(
                response
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("the bot refused the command")
                    .to_string(),
            ))
        }
    }
}

/// Read one JSON line; a non-JSON line is skipped.
async fn read_frame(reader: &mut BufReader<Box<dyn AsyncReadHalf>>) -> Result<Value> {
    let mut line = String::new();
    loop {
        line.clear();
        let read = (&mut *reader)
            .take(MAX_BOT_FRAME_BYTES + 1)
            .read_line(&mut line)
            .await?;
        if read == 0 {
            bail!("the bot link closed");
        }
        if read as u64 > MAX_BOT_FRAME_BYTES {
            bail!("the bot sent a frame longer than {MAX_BOT_FRAME_BYTES} bytes");
        }
        if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
            return Ok(value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_frame_without_an_end_is_refused_at_the_limit() {
        let endless: Box<dyn AsyncReadHalf> = Box::new(tokio::io::repeat(b'a'));
        let error = read_frame(&mut BufReader::new(endless)).await.unwrap_err();
        assert_eq!(
            error.to_string(),
            format!("the bot sent a frame longer than {MAX_BOT_FRAME_BYTES} bytes")
        );
    }
}
