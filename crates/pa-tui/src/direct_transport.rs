//! Direct worker transport: the client half of the direct-attach path (TS
//! `daemon-routed-client.ts` and the direct half of `daemon-worker-client.ts`).
//!
//! One logical daemon connection over two sockets: session-plane commands and
//! events go straight to the session worker's socket (single-use supervisor
//! ticket, `peer_auth`), everything else goes to the supervisor. The
//! supervisor is out of the streaming path entirely, so a supervisor death
//! mid-stream does not disturb an attached client.
//!
//! Every failure to establish or use the direct link degrades silently to
//! supervisor routing: `connect_direct` returns an error and the caller keeps
//! the plain supervisor connection (transition-period fallback, TS
//! `createDaemonSessionTransport`).

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use pa_types::daemon::{
    framing, DaemonClientCapability, DaemonPeerCommand, DaemonPeerTransportTicket,
};
use pa_types::platform::transport::connect_transport;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use tokio::time::timeout;

use crate::daemon_client::{client_event_from_value, DaemonClientEvent, Shared};

/// TS `DaemonWorkerClient.connect` budget for the worker socket.
const CONNECT_TIMEOUT_MS: u64 = 1_000;
/// TS `waitForHello` / `authenticatePeer` budget.
const HELLO_TIMEOUT_MS: u64 = 3_000;
/// TS `get_direct_worker_transport` request budget in
/// `createDaemonSessionTransport` (with `recoverable: false`).
pub(crate) const TICKET_TIMEOUT_MS: u64 = 5_000;
/// The supervisor capability that enables the upgrade.
pub(crate) const DIRECT_PEER_TRANSPORT_CAPABILITY: &str = "direct_peer_transport";

/// One live direct link to a session worker.
#[derive(Debug, Clone)]
pub(crate) struct DirectLink {
    /// The session the ticket was granted for.
    pub(crate) active_session_id: String,
    /// The worker socket this link is pinned to.
    pub(crate) socket_path: String,
    writer: mpsc::UnboundedSender<Vec<u8>>,
    alive: Arc<AtomicBool>,
}

impl DirectLink {
    pub(crate) fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst) && !self.writer.is_closed()
    }

    /// Queue one encoded frame. `false` when the writer pump is gone.
    pub(crate) fn send(&self, frame: Vec<u8>) -> bool {
        self.writer.send(frame).is_ok()
    }

    /// Mark the link dead; the writer pump exits after draining.
    pub(crate) fn close(&self) {
        self.alive.store(false, Ordering::SeqCst);
    }
}

/// The client's direct-transport state: the retained event-channel sender
/// (spawning direct reader pumps needs one; `close` drops it so the UI's
/// event channel closes with the last reader) and the live link. Held by
/// [`DaemonClient`](crate::daemon_client::DaemonClient) behind one `Arc` so
/// the client struct stays small.
#[derive(Default)]
pub(crate) struct DirectState {
    event_tx: std::sync::Mutex<Option<mpsc::UnboundedSender<DaemonClientEvent>>>,
    link: std::sync::Mutex<Option<DirectLink>>,
}

impl DirectState {
    pub(crate) fn new(event_tx: mpsc::UnboundedSender<DaemonClientEvent>) -> Self {
        DirectState {
            event_tx: std::sync::Mutex::new(Some(event_tx)),
            link: std::sync::Mutex::new(None),
        }
    }

    /// The live link, when one is established.
    pub(crate) fn live_link(&self) -> Option<DirectLink> {
        self.link
            .lock()
            .unwrap()
            .as_ref()
            .filter(|link| link.is_alive())
            .cloned()
    }

    /// Install a link (dropping any previous one).
    pub(crate) fn set_link(&self, link: DirectLink) {
        if let Some(previous) = self.link.lock().unwrap().replace(link) {
            previous.close();
        }
    }

    /// Drop the link and keep plain supervisor routing.
    pub(crate) fn drop_link(&self) {
        if let Some(link) = self.link.lock().unwrap().take() {
            link.close();
        }
    }

    /// The live link's session, when this client upgraded.
    pub(crate) fn session_id(&self) -> Option<String> {
        self.live_link().map(|link| link.active_session_id)
    }

    /// The retained event sender, for spawning a direct reader pump.
    pub(crate) fn event_sender(&self) -> Option<mpsc::UnboundedSender<DaemonClientEvent>> {
        self.event_tx.lock().unwrap().clone()
    }

    /// Drop the retained event sender (`close`).
    pub(crate) fn take_event_sender(&self) {
        self.event_tx.lock().unwrap().take();
    }
}

/// The authenticated identity of one direct link, echoed by `peer_auth`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DirectPeerClaim {
    pub(crate) worker_instance_id: String,
    pub(crate) active_session_id: String,
    pub(crate) purpose: String,
}

/// Port of `readSessionTransportTicket` plus the client-side validation:
/// shape, target session, freshness, and socket-filesystem identity.
pub(crate) fn read_session_transport_ticket(
    data: &Value,
    active_session_id: &str,
) -> Result<DaemonPeerTransportTicket> {
    let ticket: DaemonPeerTransportTicket =
        serde_json::from_value(data.clone()).context("invalid direct transport ticket")?;
    if ticket.purpose != "session_client"
        || ticket.socket_path.is_empty()
        || ticket.worker_instance_id.is_empty()
        || ticket.active_session_id.is_empty()
        || ticket.grant_id.is_empty()
        || ticket.token.is_empty()
        || ticket.expires_at.is_empty()
    {
        bail!("incomplete direct transport ticket");
    }
    if ticket.active_session_id != active_session_id {
        bail!("direct transport ticket names another session");
    }
    let expires = iso_to_unix_ms(&ticket.expires_at).unwrap_or(0);
    if expires <= unix_now_ms() {
        bail!("direct transport ticket expired");
    }
    let Some(current) = pa_types::platform::socket_identity(Path::new(&ticket.socket_path)) else {
        bail!("direct transport socket is gone");
    };
    if current != ticket.socket_identity {
        bail!("direct transport socket identity changed");
    }
    Ok(ticket)
}

/// Whether the supervisor advertises direct peer transport.
pub(crate) fn supervisor_supports_direct(hello: &Value) -> bool {
    hello
        .get("serverCapabilities")
        .and_then(Value::as_array)
        .map(|capabilities: &Vec<Value>| {
            capabilities
                .iter()
                .any(|capability| capability.as_str() == Some(DIRECT_PEER_TRANSPORT_CAPABILITY))
        })
        .unwrap_or(false)
}

/// Connect to the worker socket, complete the hello + `peer_auth` handshake,
/// and spawn the link's writer and reader pumps. The reader resolves
/// responses through `shared` and forwards events to `event_tx` (the same
/// channel the supervisor reader feeds).
pub(crate) async fn connect_direct(
    ticket: &DaemonPeerTransportTicket,
    shared: Arc<Shared>,
    event_tx: mpsc::UnboundedSender<DaemonClientEvent>,
) -> Result<DirectLink> {
    let stream = timeout(
        Duration::from_millis(CONNECT_TIMEOUT_MS),
        connect_transport(Path::new(&ticket.socket_path)),
    )
    .await
    .map_err(|_| anyhow!("timed out connecting to the session worker socket"))?
    .context("failed to connect to the session worker socket")?;
    let (reader, writer) = stream.split();

    // The worker greets first; then peer_auth must be the first command.
    let mut reader =
        framing::PrivateFrameReader::new(reader, framing::DEFAULT_PRIVATE_FRAME_LIMITS);
    let mut writer = writer;
    let hello = timeout(Duration::from_millis(HELLO_TIMEOUT_MS), reader.read_frame())
        .await
        .map_err(|_| anyhow!("timed out waiting for the session worker hello"))?
        .context("session worker closed before its hello")?
        .ok_or_else(|| anyhow!("session worker closed before its hello"))?;
    if hello.header.get("outboundType").and_then(Value::as_str) != Some("daemon_hello") {
        bail!("unexpected first frame from the session worker");
    }

    let request_id = format!("direct_peer_{}", ticket.grant_id);
    let presentation = DaemonPeerCommand::PeerAuth {
        id: Some(request_id.clone()),
        grant_id: ticket.grant_id.clone(),
        token: ticket.token.clone(),
        worker_instance_id: ticket.worker_instance_id.clone(),
        purpose: ticket.purpose.clone(),
        rest: Default::default(),
    };
    let frame = framing::encode_private_frame(
        &json!({
            "kind": "command",
            "requestId": request_id,
            "commandType": "peer_auth",
        }),
        &serde_json::to_vec(&presentation)?,
        framing::DEFAULT_PRIVATE_FRAME_LIMITS,
    )?;
    writer
        .write_all(&frame)
        .await
        .context("failed to send peer_auth")?;
    writer.flush().await?;

    let claim = timeout(
        Duration::from_millis(HELLO_TIMEOUT_MS),
        read_peer_auth_response(&mut reader, &request_id),
    )
    .await
    .map_err(|_| anyhow!("timed out waiting for the peer_auth response"))??;
    if claim.active_session_id != ticket.active_session_id {
        bail!("peer_auth admitted the wrong session");
    }

    let alive = Arc::new(AtomicBool::new(true));
    let (frame_tx, mut frame_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    // Writer pump: one frame at a time, exits when the link closes.
    tokio::spawn(async move {
        while let Some(frame) = frame_rx.recv().await {
            if writer.write_all(&frame).await.is_err() || writer.flush().await.is_err() {
                break;
            }
        }
        let _ = writer.shutdown().await;
    });
    // Reader pump: responses to the shared pending map, events to the UI.
    {
        let shared = Arc::clone(&shared);
        let event_tx = event_tx.clone();
        let alive = Arc::clone(&alive);
        let active_session_id = ticket.active_session_id.clone();
        tokio::spawn(async move {
            while let Ok(Some(frame)) = reader.read_frame().await {
                let header_type = frame
                    .header
                    .get("outboundType")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let Ok(payload) = serde_json::from_slice::<Value>(&frame.payload) else {
                    continue;
                };
                if header_type == "response" {
                    if let Ok(response) =
                        serde_json::from_value::<pa_types::daemon::DaemonResponse>(payload.clone())
                    {
                        let request_id = frame
                            .header
                            .get("requestId")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        shared.resolve(&request_id, response);
                    }
                } else if let Some(event) = client_event_from_value(&payload) {
                    let _ = event_tx.send(event);
                }
            }
            // The worker socket closed: every direct-link request in
            // flight fails now instead of riding out its timeout.
            shared.fail_pending("direct_", "the session connection closed");
            // An intentional close (client `close`, session switch, link
            // replacement) marks the link dead before its writer's
            // shutdown reaches this EOF; only an unmarked exit is the
            // worker's own death, which arms the re-attach loop.
            if alive.swap(false, Ordering::SeqCst) {
                let _ = event_tx.send(DaemonClientEvent::DirectLinkLost {
                    active_session_id: active_session_id.clone(),
                });
            }
        });
    }
    Ok(DirectLink {
        active_session_id: ticket.active_session_id.clone(),
        socket_path: ticket.socket_path.clone(),
        writer: frame_tx,
        alive,
    })
}

/// Read frames until the `peer_auth` response lands.
async fn read_peer_auth_response<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut framing::PrivateFrameReader<R>,
    request_id: &str,
) -> Result<DirectPeerClaim> {
    loop {
        let Some(frame) = reader
            .read_frame()
            .await
            .context("session worker closed during peer_auth")?
        else {
            bail!("session worker closed during peer_auth");
        };
        if frame.header.get("outboundType").and_then(Value::as_str) != Some("response")
            || frame.header.get("requestId").and_then(Value::as_str) != Some(request_id)
        {
            continue;
        }
        let response: pa_types::daemon::DaemonResponse = serde_json::from_slice(&frame.payload)?;
        if !response.success {
            bail!(
                "peer authentication failed: {}",
                response
                    .error
                    .unwrap_or_else(|| "unknown error".to_string())
            );
        }
        let data = response.data.unwrap_or(Value::Null);
        let claim = DirectPeerClaim {
            worker_instance_id: data
                .get("workerInstanceId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            active_session_id: data
                .get("activeSessionId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            purpose: data
                .get("purpose")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        };
        return Ok(claim);
    }
}

fn unix_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// ISO-8601 UTC timestamp to epoch milliseconds (the ticket `expiresAt`
/// check). Accepts the `new Date().toISOString()` shape with optional
/// fraction.
fn iso_to_unix_ms(iso: &str) -> Option<u64> {
    let bytes = iso.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let year: i64 = iso.get(0..4)?.parse().ok()?;
    let month = iso.get(5..7)?.parse::<u32>().ok()?;
    let day = iso.get(8..10)?.parse::<u32>().ok()?;
    let hour = iso.get(11..13)?.parse::<u32>().ok()?;
    let minute = iso.get(14..16)?.parse::<u32>().ok()?;
    let second = iso.get(17..19)?.parse::<u32>().ok()?;
    let millis: u64 = if bytes.len() > 20 && bytes[19] == b'.' {
        let digits: String = iso[20..].chars().take_while(char::is_ascii_digit).collect();
        if digits.is_empty() {
            return None;
        }
        let mut scaled = [b'0'; 3];
        for (slot, digit) in scaled.iter_mut().zip(digits.as_bytes()) {
            *slot = *digit;
        }
        String::from_utf8(scaled.to_vec()).ok()?.parse().ok()?
    } else {
        0
    };
    if !(1..=12).contains(&month) || day == 0 || day > 31 || hour > 23 || minute > 59 || second > 59
    {
        return None;
    }
    let days = days_from_civil(year, month, day);
    Some(
        (days * 86_400 * 1000
            + hour as i64 * 3_600_000
            + minute as i64 * 60_000
            + second as i64 * 1_000
            + millis as i64) as u64,
    )
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy as i64;
    era * 146_097 + doe - 719_468
}

/// Capability filter used when the direct link stamps attach commands the
/// way the supervisor's routed attach does (slim snapshot in the response).
pub(crate) fn direct_attach_capabilities() -> Vec<DaemonClientCapability> {
    vec![
        "attach_snapshot".to_string(),
        "event_sequence".to_string(),
        "slim_attach".to_string(),
    ]
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn ticket_json(expires_at: &str) -> (serde_json::Value, tempfile::TempDir) {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("worker.sock");
        // A real socket file so the identity check has something to stat.
        std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let identity = pa_types::platform::socket_identity(&socket).unwrap();
        let ticket = json!({
            "purpose": "session_client",
            "socketPath": socket.to_string_lossy(),
            "socketIdentity": { "dev": identity.dev, "ino": identity.ino },
            "workerInstanceId": "inst-1",
            "activeSessionId": "abc123",
            "grantId": "g1",
            "token": "t",
            "expiresAt": expires_at,
        });
        (ticket, dir)
    }

    /// Minimal scripted worker used by the link tests: hello, one
    /// `peer_auth` response, then the process dies (the socket tears down
    /// the way a SIGKILLed worker does).
    async fn spawn_mock_worker(listener: tokio::net::UnixListener) {
        let (stream, _) = listener.accept().await.expect("accept");
        let (reader, mut writer) = stream.into_split();
        let mut reader =
            framing::PrivateFrameReader::new(reader, framing::DEFAULT_PRIVATE_FRAME_LIMITS);
        let hello = framing::encode_private_frame(
            &json!({ "kind": "outbound", "outboundType": "daemon_hello" }),
            &serde_json::to_vec(&json!({ "type": "daemon_hello" })).unwrap(),
            framing::DEFAULT_PRIVATE_FRAME_LIMITS,
        )
        .unwrap();
        writer.write_all(&hello).await.unwrap();
        writer.flush().await.unwrap();
        let Some(frame) = reader.read_frame().await.unwrap() else {
            return;
        };
        let request_id = frame
            .header
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap()
            .to_string();
        let response = json!({
            "type": "response",
            "id": request_id,
            "command": "peer_auth",
            "success": true,
            "data": {
                "workerInstanceId": "inst-1",
                "activeSessionId": "abc123",
                "purpose": "session_client",
            },
        });
        let frame = framing::encode_private_frame(
            &json!({ "kind": "outbound", "outboundType": "response", "requestId": request_id }),
            &serde_json::to_vec(&response).unwrap(),
            framing::DEFAULT_PRIVATE_FRAME_LIMITS,
        )
        .unwrap();
        writer.write_all(&frame).await.unwrap();
        writer.flush().await.unwrap();
        // The worker process dies.
        drop(writer);
    }

    async fn live_link_and_channel() -> (
        DirectLink,
        mpsc::UnboundedReceiver<DaemonClientEvent>,
        tempfile::TempDir,
    ) {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("worker.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let identity = pa_types::platform::socket_identity(&socket).unwrap();
        let ticket = DaemonPeerTransportTicket {
            purpose: "session_client".to_string(),
            socket_path: socket.to_string_lossy().to_string(),
            socket_identity: identity,
            worker_instance_id: "inst-1".to_string(),
            active_session_id: "abc123".to_string(),
            grant_id: "g1".to_string(),
            token: "t".to_string(),
            expires_at: "2999-01-01T00:00:00.000Z".to_string(),
        };
        tokio::spawn(async move { spawn_mock_worker(listener).await });
        let shared = Arc::new(crate::daemon_client::Shared::default());
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let link = connect_direct(&ticket, shared, event_tx)
            .await
            .expect("direct link");
        (link, event_rx, dir)
    }

    #[tokio::test]
    async fn worker_death_emits_direct_link_lost() {
        let (link, mut events, _dir) = live_link_and_channel().await;
        assert!(link.is_alive());
        // The worker socket tears down; the reader pump must report the
        // lost session so the UI arms its re-attach loop.
        let event = tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(
                &event,
                DaemonClientEvent::DirectLinkLost {
                    active_session_id
                } if active_session_id == "abc123"
            ),
            "unexpected event: {event:?}"
        );
    }

    #[tokio::test]
    async fn intentional_close_does_not_emit_direct_link_lost() {
        let (link, mut events, _dir) = live_link_and_channel().await;
        // A session switch marks the link dead before its EOF arrives;
        // the pump must not arm a re-attach for an intentional close.
        link.close();
        let event = tokio::time::timeout(Duration::from_millis(300), events.recv()).await;
        // The worker's EOF still ends the pump (the channel closes), but no
        // `DirectLinkLost` may ride it for an intentionally closed link.
        assert!(
            !matches!(event, Ok(Some(DaemonClientEvent::DirectLinkLost { .. }))),
            "intentional close must not emit DirectLinkLost: {event:?}"
        );
    }

    #[test]
    fn ticket_shape_gates() {
        const FRESH: &str = "2999-01-01T00:00:00.000Z";
        const STALE: &str = "2000-01-01T00:00:00.000Z";
        let (value, _dir) = ticket_json(FRESH);
        let ticket = read_session_transport_ticket(&value, "abc123").expect("valid ticket");
        assert_eq!(ticket.grant_id, "g1");

        // Wrong session target.
        assert!(read_session_transport_ticket(&value, "other").is_err());
        // Expired.
        let (expired, _d2) = ticket_json(STALE);
        assert!(read_session_transport_ticket(&expired, "abc123").is_err());
        // Wrong socket identity (a different file).
        let (mut moved, _d3) = ticket_json(FRESH);
        moved["socketIdentity"]["ino"] = json!(1);
        assert!(read_session_transport_ticket(&moved, "abc123").is_err());
        // Missing fields.
        let (mut missing, _d4) = ticket_json(FRESH);
        missing["token"] = json!("");
        assert!(read_session_transport_ticket(&missing, "abc123").is_err());
    }

    #[test]
    fn iso_parse_covers_ticket_expiry() {
        assert_eq!(iso_to_unix_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(iso_to_unix_ms("1970-01-01T00:00:01Z"), Some(1_000));
        assert_eq!(iso_to_unix_ms("garbage"), None);
        assert_eq!(iso_to_unix_ms("2024-13-01T00:00:00Z"), None);
    }
}
