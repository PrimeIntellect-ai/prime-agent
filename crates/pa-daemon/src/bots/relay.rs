//! The in-sandbox relay behind the hidden `prime-agent relay` command:
//! one process per link, started by the Mac through the sandbox's exec
//! channel, pumping bytes between the exec stream (its stdin/stdout) and
//! the guest daemon's socket. The relay owns no protocol logic: bytes in,
//! bytes out, one line at a time.
//!
//! The relay process is disposable: the Mac terminates it when its link
//! drops, and a reconnect starts a new relay.

use std::path::PathBuf;

use pa_types::platform::transport::{connect_transport, AsyncReadHalf, AsyncWriteHalf};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// The guest socket coordinate the relay reads; the link sets it.
pub const BRIDGE_SOCKET_ENV: &str = "PRIME_AGENT_CLOUD_BRIDGE_SOCKET";

/// Run the relay until either side closes. One line of stdin becomes
/// one line to the guest socket; one guest frame becomes one line of
/// stdout.
///
/// # Errors
///
/// Returns the error when the socket cannot be connected or the
/// pumping fails.
pub async fn run_guest_relay() -> anyhow::Result<()> {
    let socket = std::env::var(BRIDGE_SOCKET_ENV).ok().ok_or_else(|| {
        anyhow::anyhow!("missing {BRIDGE_SOCKET_ENV}: the relay needs the guest socket path")
    })?;
    let socket: PathBuf = PathBuf::from(socket);
    let guest = connect_transport(&socket).await?;
    let (guest_read, guest_write) = guest.split();

    // Either direction ending ends the relay: the exec channel never
    // closes stdin, so waiting for both would keep the relay (and its
    // guest client slot) alive after the guest closed its side.
    tokio::select! {
        result = pump(StdioHalf::reader(), guest_write) => result,
        result = pump(guest_read, StdioHalf::writer()) => result,
    }
}

/// Pump one direction line-by-line until EOF, then half-close.
async fn pump(
    mut from: Box<dyn AsyncReadHalf>,
    mut to: Box<dyn AsyncWriteHalf>,
) -> anyhow::Result<()> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let read = from.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
            let mut line: Vec<u8> = buffer[..=newline].to_vec();
            buffer.drain(..=newline);
            to.write_all(&line).await?;
            line.clear();
        }
    }
    if !buffer.is_empty() {
        let tail = std::mem::take(&mut buffer);
        to.write_all(&tail).await?;
    }
    let _ = to.flush().await;
    Ok(())
}

/// The exec channel's stdin/stdout halves (tokio's standard handles).
struct StdioHalf;

impl StdioHalf {
    fn reader() -> Box<dyn AsyncReadHalf> {
        Box::new(tokio::io::stdin())
    }
    fn writer() -> Box<dyn AsyncWriteHalf> {
        Box::new(tokio::io::stdout())
    }
}
