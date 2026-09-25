//! The worker-side half of worker-to-worker peer delivery: a one-shot
//! private-frame client for another worker's direct socket (thin-supervisor
//! stage 3). The supervisor mints a single-use `worker` grant; this client
//! burns it with `peer_auth` and delivers `worker_deliver_message` straight
//! to the target worker, bypassing the supervisor's route plane (the
//! delivery keeps flowing when the supervisor is mid-restart, and the
//! route plane never sees agent-message traffic). The connection is
//! short-lived by design: one delivery round trip, then close.

use anyhow::{anyhow, Context, Result};
use pa_types::daemon::DaemonPeerTransportTicket;
use pa_types::platform::transport::connect_transport;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;

use crate::framing::{encode_private_frame, PrivateFrameReader, DEFAULT_PRIVATE_FRAME_LIMITS};
use crate::peer::PEER_PURPOSE_WORKER;
use crate::protocol::DaemonResponse;

/// One delivery round trip: hello, `peer_auth`, `worker_deliver_message`.
const DELIVERY_TIMEOUT_MS: u64 = 15_000;

/// The outcome of one direct-delivery attempt. The distinction matters
/// because the grant burns on first use: nothing may be retried once the
/// delivery command has been sent.
pub(crate) enum PeerDeliveryOutcome {
    /// The target answered this response (a failure response is final
    /// too - the target refused the delivery). Boxed: the response's
    /// insertion-ordered JSON maps (`preserve_order`, wire parity) would
    /// dwarf the empty variants (`large_enum_variant`).
    Answered(Box<DaemonResponse>),
    /// The link could not be established (connect, hello, or the grant
    /// burn failed at the door): nothing was delivered, a fallback may
    /// take over.
    NotEstablished,
    /// The delivery command was sent but no answer arrived; the delivery
    /// may have landed, so the attempt is final either way.
    Lost,
}

/// Burn the ticket's grant on the target worker's socket and deliver one
/// agent message directly.
pub(crate) async fn deliver_message_over_peer_transport(
    ticket: &DaemonPeerTransportTicket,
    target_active_session_id: &str,
    message: &str,
    sender: &Value,
    delivery_mode: Option<&str>,
) -> PeerDeliveryOutcome {
    let future = deliver_once(
        ticket,
        target_active_session_id,
        message,
        sender,
        delivery_mode,
    );
    match tokio::time::timeout(
        std::time::Duration::from_millis(DELIVERY_TIMEOUT_MS),
        future,
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(_) => PeerDeliveryOutcome::Lost,
    }
}

async fn deliver_once(
    ticket: &DaemonPeerTransportTicket,
    target_active_session_id: &str,
    message: &str,
    sender: &Value,
    delivery_mode: Option<&str>,
) -> PeerDeliveryOutcome {
    // Link establishment: connect, hello, and the grant burn. Any failure
    // here means nothing was delivered.
    let stream = match connect_transport(std::path::Path::new(&ticket.socket_path)).await {
        Ok(stream) => stream,
        Err(_) => return PeerDeliveryOutcome::NotEstablished,
    };
    let (reader, mut writer) = stream.split();
    let mut reader = PrivateFrameReader::new(reader, DEFAULT_PRIVATE_FRAME_LIMITS);
    // Consume the daemon hello (every connection gets one immediately).
    if read_frame(&mut reader).await.is_err() {
        return PeerDeliveryOutcome::NotEstablished;
    }
    // Burn the grant: peer_auth with the `worker` purpose.
    let auth = match request(
        &mut writer,
        &mut reader,
        "peer_auth",
        &json!({
            "type": "peer_auth",
            "grantId": ticket.grant_id,
            "token": ticket.token,
            "workerInstanceId": ticket.worker_instance_id,
            "purpose": PEER_PURPOSE_WORKER,
        }),
    )
    .await
    {
        Ok(auth) => auth,
        Err(_) => return PeerDeliveryOutcome::NotEstablished,
    };
    if !auth.success {
        return PeerDeliveryOutcome::NotEstablished;
    }
    // Delivery: the command is sent, so every outcome from here is final.
    let mut payload = json!({
        "type": "worker_deliver_message",
        "targetActiveSessionId": target_active_session_id,
        "message": message,
        "sender": sender,
    });
    if let Some(mode) = delivery_mode {
        payload["deliveryMode"] = json!(mode);
    }
    match request(&mut writer, &mut reader, "worker_deliver_message", &payload).await {
        Ok(response) => PeerDeliveryOutcome::Answered(Box::new(response)),
        Err(_) => PeerDeliveryOutcome::Lost,
    }
}

/// One command frame with a fresh request id, then the matching response.
async fn request(
    writer: &mut Box<dyn pa_types::platform::transport::AsyncWriteHalf>,
    reader: &mut PrivateFrameReader<Box<dyn pa_types::platform::transport::AsyncReadHalf>>,
    command_type: &str,
    payload: &Value,
) -> Result<DaemonResponse> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let frame = encode_private_frame(
        &json!({
            "kind": "command",
            "requestId": request_id,
            "commandType": command_type,
        }),
        &serde_json::to_vec(payload).context("serialize peer command")?,
        DEFAULT_PRIVATE_FRAME_LIMITS,
    )?;
    writer
        .write_all(&frame)
        .await
        .context("write peer command")?;
    writer.flush().await?;
    loop {
        let frame = read_frame(reader).await?;
        let matches = frame
            .header
            .get("requestId")
            .and_then(Value::as_str)
            .is_some_and(|id| id == request_id)
            && frame.header.get("outboundType").and_then(Value::as_str) == Some("response");
        if matches {
            let response: DaemonResponse =
                serde_json::from_slice(&frame.payload).context("parse peer response")?;
            return Ok(response);
        }
    }
}

/// Read one private frame; a clean EOF between requests is a broken link.
async fn read_frame(
    reader: &mut PrivateFrameReader<Box<dyn pa_types::platform::transport::AsyncReadHalf>>,
) -> Result<crate::framing::PrivateFrame> {
    reader
        .read_frame()
        .await?
        .ok_or_else(|| anyhow!("peer worker closed the connection"))
}
