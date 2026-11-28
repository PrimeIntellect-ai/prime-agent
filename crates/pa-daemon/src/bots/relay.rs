//! The in-sandbox relay behind the hidden `prime-agent relay` command:
//! one process per link, started by the Mac through the sandbox's exec
//! channel, pumping bytes between the exec stream (its stdin/stdout) and
//! the guest daemon's socket. The relay owns no protocol logic: bytes in,
//! bytes out.
//!
//! The relay process is disposable: the Mac terminates it when its link
//! drops, and a reconnect starts a new relay.

use std::path::PathBuf;

use pa_types::platform::transport::{connect_transport, AsyncReadHalf, AsyncWriteHalf};

/// The guest socket coordinate the relay reads; the link sets it.
pub const BRIDGE_SOCKET_ENV: &str = "PRIME_AGENT_CLOUD_BRIDGE_SOCKET";

/// Run the relay until either side closes: stdin is copied to the guest
/// socket, and the guest socket to stdout.
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

/// Copy one direction until EOF. The copy flushes whenever its reader
/// waits, so each frame reaches the other side as it arrives.
async fn pump(
    mut from: Box<dyn AsyncReadHalf>,
    mut to: Box<dyn AsyncWriteHalf>,
) -> anyhow::Result<()> {
    tokio::io::copy(&mut from, &mut to).await?;
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
