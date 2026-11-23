//! `attach_bot`: hand a bot's guest daemon connection to a local TUI. The daemon opens the
//! link (which checks the guest's version and keeps its hello first), then serves it on a
//! single-use local endpoint: the first client gets the raw bytes both ways. The attach guard
//! lives as long as the pipe, so the pause policy sees the attach.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use pa_types::platform::transport::{bind_transport, TransportStream};

use super::BotManager;

/// How long an endpoint waits for its one client before the link closes.
const ACCEPT_TIMEOUT: Duration = Duration::from_secs(15);

/// A prepared attach: the endpoint to connect to, and the bot's session in the guest daemon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BotAttach {
    pub endpoint: PathBuf,
    pub guest_session_id: String,
}

/// Resume the bot when needed, open its link, and serve the link on a fresh endpoint under
/// `agent_dir`.
///
/// # Errors
///
/// Returns `Err` when the bot cannot run, the link cannot open (a guest on another version
/// fails with the link's `VersionMismatch`), or the endpoint cannot bind.
pub async fn attach_bot(manager: &BotManager, agent_dir: &Path, bot_id: &str) -> Result<BotAttach> {
    let record = manager.ensure_running(bot_id).await?;
    let guard = manager.attach_guard(bot_id);
    let stream = manager.open_link(&record).await?;
    let endpoint = serve_link(stream, &endpoint_dir(agent_dir)?, guard).await?;
    Ok(BotAttach {
        endpoint,
        guest_session_id: record.guest_session_id,
    })
}

/// The private directory the endpoints live in (owner-only on Unix, like the daemon socket).
fn endpoint_dir(agent_dir: &Path) -> Result<PathBuf> {
    let dir = agent_dir.join("bots").join("attach");
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir)
}

/// Bind a single-use endpoint in `dir` and pipe `stream` to its first client in the
/// background. `guard` drops when the pipe ends.
async fn serve_link<G: Send + 'static>(
    stream: Box<dyn TransportStream>,
    dir: &Path,
    guard: G,
) -> Result<PathBuf> {
    let simple = uuid::Uuid::new_v4().simple().to_string();
    let endpoint = dir.join(format!("{}.sock", &simple[..16]));
    let listener = bind_transport(&endpoint).await?;
    let path = endpoint.clone();
    tokio::spawn(async move {
        let _guard = guard;
        let accepted = tokio::time::timeout(ACCEPT_TIMEOUT, listener.accept()).await;
        drop(listener);
        let _ = std::fs::remove_file(&path);
        let Ok(Ok(client)) = accepted else { return };
        let (mut guest_reader, mut guest_writer) = stream.split();
        let (mut client_reader, mut client_writer) = client.split();
        // Either direction ending ends the attach; dropping the halves closes the link.
        tokio::select! {
            _ = tokio::io::copy(&mut guest_reader, &mut client_writer) => {}
            _ = tokio::io::copy(&mut client_reader, &mut guest_writer) => {}
        }
    });
    Ok(endpoint)
}

#[cfg(all(test, unix))]
mod tests {
    use super::super::link::VersionMismatch;
    use super::super::tests::{setup, spec};
    use super::*;
    use pa_types::platform::transport::connect_transport;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

    #[tokio::test]
    async fn a_guest_on_another_version_refuses_the_attach() {
        let (dir, platform, manager) = setup();
        let bot = manager.spawn(&spec("bot-a")).await.unwrap();
        platform.state().guest_app_version = Some("0.0.1".into());
        let error = attach_bot(&manager, dir.path(), &bot.bot_id)
            .await
            .unwrap_err();
        assert!(
            error.downcast_ref::<VersionMismatch>().is_some(),
            "{error:#}"
        );
        assert!(!manager.attached(&bot.bot_id));
    }

    #[tokio::test]
    async fn the_endpoint_pipes_the_link_once_and_holds_the_attach() {
        let (dir, platform, manager) = setup();
        let bot = manager.spawn(&spec("bot-a")).await.unwrap();
        let attach = attach_bot(&manager, dir.path(), &bot.bot_id).await.unwrap();
        assert_eq!(attach.guest_session_id, bot.guest_session_id);
        assert!(manager.attached(&bot.bot_id));

        let (reader, mut writer) = connect_transport(&attach.endpoint).await.unwrap().split();
        let mut reader = BufReader::new(reader);
        let mut received = String::new();
        reader.read_line(&mut received).await.unwrap();
        assert!(
            received.contains("daemon_hello"),
            "the hello comes first: {received}"
        );

        let (mut guest_stdout, mut guest_stdin) = platform.state().links.pop().unwrap();
        writer.write_all(b"ping\n").await.unwrap();
        let mut seen = [0u8; 5];
        guest_stdin.read_exact(&mut seen).await.unwrap();
        assert_eq!(&seen, b"ping\n");
        guest_stdout.write_all(b"pong\n").await.unwrap();
        received.clear();
        reader.read_line(&mut received).await.unwrap();
        assert_eq!(received, "pong\n");
        assert!(!attach.endpoint.exists(), "the endpoint is single-use");

        // Leaving the view closes the link and ends the attach.
        drop((reader, writer));
        let mut rest = Vec::new();
        guest_stdin.read_to_end(&mut rest).await.unwrap();
        for _ in 0..100 {
            if !manager.attached(&bot.bot_id) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(!manager.attached(&bot.bot_id));
    }
}
