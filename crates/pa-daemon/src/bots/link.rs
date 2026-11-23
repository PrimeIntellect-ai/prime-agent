//! The link to a bot: the Mac speaks the normal daemon protocol to the
//! guest daemon through `prime-agent relay`, started over the sandbox's
//! exec stream. The link refuses a guest whose prime-agent version differs
//! from this Mac's: both sides must speak the same protocol.

use std::collections::BTreeMap;
use std::io::Cursor;
use std::time::Duration;

use anyhow::Context;
use pa_sandbox::CommandSpec;
use pa_types::platform::transport::{AsyncReadHalf, AsyncWriteHalf, TransportStream};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, BufReader};

use super::relay::BRIDGE_SOCKET_ENV;
use super::{BotManager, BotRecord, GUEST_DAEMON_SOCKET};

/// Starts the relay in the guest.
pub(crate) const RELAY_SCRIPT: &str =
    r#"export PATH="${HOME:-/root}/.local/bin:$PATH"; exec prime-agent relay"#;

/// The longest hello line the link reads.
const MAX_HELLO_BYTES: u64 = 64 * 1024;

/// How long the guest daemon may take to say hello over the relay.
const HELLO_TIMEOUT: Duration = Duration::from_secs(60);

/// The guest runs another prime-agent version than this Mac. Its
/// `Display` names the side to upgrade and how.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{}", self.upgrade_message())]
pub struct VersionMismatch {
    /// The guest's version, `None` when its hello carries none.
    pub guest: Option<String>,
    /// This Mac's version.
    pub local: String,
}

impl VersionMismatch {
    fn upgrade_message(&self) -> String {
        let local = &self.local;
        match self.guest.as_deref() {
            Some(guest) if version_key(guest) > version_key(local) => format!(
                "The bot runs prime-agent {guest}, but this Mac runs {local}. \
                 Upgrade this Mac with `prime-agent update`, then try again."
            ),
            guest => format!(
                "The bot runs prime-agent {}, but this Mac runs {local}. \
                 Pause the bot and resume it: its sandbox then installs prime-agent {local}.",
                guest.unwrap_or("of an unknown version")
            ),
        }
    }
}

/// A version as comparable numbers: `0.10.5-beta.2` becomes `[0, 10, 5, 2]`.
fn version_key(version: &str) -> Vec<u64> {
    version
        .split(|c: char| !c.is_ascii_digit())
        .filter_map(|part| part.parse().ok())
        .collect()
}

/// Check the guest's `daemon_hello` against this Mac's version.
///
/// # Errors
///
/// Returns [`VersionMismatch`] when the versions differ or the hello
/// carries no version.
pub fn check_version(hello: &Value) -> Result<(), VersionMismatch> {
    let local = crate::protocol::app_version();
    let guest = hello.get("appVersion").and_then(Value::as_str);
    if guest == Some(local) {
        return Ok(());
    }
    Err(VersionMismatch {
        guest: guest.map(str::to_string),
        local: local.to_string(),
    })
}

impl BotManager {
    /// Open a link to a running bot: start the relay through the exec
    /// stream, read the guest's hello, and refuse a version mismatch. The
    /// returned stream still yields the hello first, so a normal daemon
    /// client handshakes over it unchanged. Dropping the stream ends the
    /// relay.
    ///
    /// # Errors
    ///
    /// Returns the error when the bot has no sandbox, the relay cannot
    /// start, the guest sends no hello in time, or its version differs
    /// ([`VersionMismatch`]).
    pub async fn open_link(&self, bot: &BotRecord) -> anyhow::Result<Box<dyn TransportStream>> {
        let sandbox_id = bot
            .sandbox_id
            .as_deref()
            .with_context(|| format!("the bot {} has no sandbox", bot.name))?;
        // The release installer puts the binary in ~/.local/bin, which is
        // not on the exec PATH.
        let command = CommandSpec {
            cmd: "bash".into(),
            args: vec!["-c".into(), RELAY_SCRIPT.into()],
            envs: BTreeMap::from([(
                BRIDGE_SOCKET_ENV.to_string(),
                GUEST_DAEMON_SOCKET.to_string(),
            )]),
            cwd: None,
        };
        let halves = self.platform.open_stream(sandbox_id, &command).await?;
        // Dropping the halves on a timeout ends the relay.
        tokio::time::timeout(
            HELLO_TIMEOUT,
            handshake(halves.read, halves.write, halves.ended),
        )
            .await
            .map_err(|_| {
                anyhow::anyhow!(
                    "the bot {} did not say hello within {}s",
                    bot.name,
                    HELLO_TIMEOUT.as_secs()
                )
            })?
    }
}

/// How long a link that closed before the hello waits to learn how the relay ended.
const RELAY_END_WAIT: Duration = Duration::from_secs(5);

/// Read the hello line, check the version, and put the line back in front
/// of the read half. A relay that ends first names its exit code and stderr.
async fn handshake<R, W>(
    read: R,
    write: W,
    ended: tokio::sync::oneshot::Receiver<String>,
) -> anyhow::Result<Box<dyn TransportStream>>
where
    R: AsyncRead + Unpin + Send + Sync + 'static,
    W: AsyncWrite + Unpin + Send + Sync + 'static,
{
    let mut reader = BufReader::new(read);
    let mut line = String::new();
    let read = (&mut reader)
        .take(MAX_HELLO_BYTES + 1)
        .read_line(&mut line)
        .await?;
    if read as u64 > MAX_HELLO_BYTES {
        anyhow::bail!("the bot's daemon hello is longer than {MAX_HELLO_BYTES} bytes");
    }
    if read == 0 {
        let relay = match tokio::time::timeout(RELAY_END_WAIT, ended).await {
            Ok(Ok(relay)) => relay,
            Ok(Err(_)) | Err(_) => "its end is unknown".to_string(),
        };
        anyhow::bail!("the bot closed the link before its daemon said hello (relay: {relay})");
    }
    let hello: Value = serde_json::from_str(&line)
        .map_err(|error| anyhow::anyhow!("the bot's daemon sent no hello: {error}"))?;
    if hello.get("type").and_then(Value::as_str) != Some("daemon_hello") {
        anyhow::bail!("the bot's daemon sent no hello");
    }
    check_version(&hello)?;
    Ok(Box::new(LinkStream {
        read: Cursor::new(line.into_bytes()).chain(reader),
        write,
    }))
}

/// The relayed connection's two halves.
struct LinkStream<R, W> {
    read: R,
    write: W,
}

impl<R, W> TransportStream for LinkStream<R, W>
where
    R: AsyncRead + Unpin + Send + Sync + 'static,
    W: AsyncWrite + Unpin + Send + Sync + 'static,
{
    fn split(self: Box<Self>) -> (Box<dyn AsyncReadHalf>, Box<dyn AsyncWriteHalf>) {
        (Box::new(self.read), Box::new(self.write))
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{setup, spec};
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn a_guest_on_another_version_is_refused() {
        let (_dir, platform, manager) = setup();
        let bot = manager.spawn(&spec("bot-a")).await.unwrap();
        platform.state().guest_app_version = Some("0.0.1".into());
        let error = manager.open_link(&bot).await.err().expect("refused");
        let mismatch = error.downcast::<VersionMismatch>().unwrap();
        assert_eq!(mismatch.guest.as_deref(), Some("0.0.1"));
        assert_eq!(mismatch.local, crate::protocol::app_version());
    }

    #[tokio::test(start_paused = true)]
    async fn a_matching_guest_keeps_its_hello_for_the_client() {
        let (_dir, platform, manager) = setup();
        let bot = manager.spawn(&spec("bot-a")).await.unwrap();
        let (mut read, _write) = manager.open_link(&bot).await.unwrap().split();
        platform.state().links.clear();
        let mut replayed = String::new();
        read.read_to_string(&mut replayed).await.unwrap();
        let hello: Value = serde_json::from_str(&replayed).unwrap();
        assert_eq!(hello["type"], "daemon_hello");
        assert!(check_version(&hello).is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn a_relay_that_ends_before_the_hello_names_its_end() {
        let (_dir, platform, manager) = setup();
        let bot = manager.spawn(&spec("bot-a")).await.unwrap();
        let end = r#"exit code 1, stderr: "Error: unknown command""#;
        platform.state().relay_end = Some(end.to_string());
        let error = manager.open_link(&bot).await.err().expect("refused");
        assert_eq!(
            error.to_string(),
            format!("the bot closed the link before its daemon said hello (relay: {end})")
        );
    }

    #[test]
    fn versions_compare_by_number() {
        assert!(version_key("1.0.0") > version_key("0.10.5"));
        assert!(version_key("0.9.12") < version_key("0.10.5"));
        assert!(version_key("0.10.5-beta.2") > version_key("0.10.5"));
    }
}
