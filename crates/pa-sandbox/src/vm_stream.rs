//! One live command-session stream and its pump. Port of the stream half
//! of `vm-process-client.ts` (TS branch `feat/direct-cloud-sandbox`); the
//! wire contract and safety contract live in [`crate::vm_process`].
//!
//! Event ordering is the sandboxd stream contract: a start event, then
//! data (stdout/stderr/pty) and keepalive events, then exactly one end
//! event (replayed for sessions that exited within sandboxd's retention
//! window). Keepalives are transport liveness only and are not yielded.
//!
//! Documented deviation from the TS stream: the first start event is
//! consumed by the client's `start`/`connect` call (it resolves the pid
//! and gates the returned stream on it), so the consumer never sees it;
//! the TS iterator yields it once. The sandboxd contract always sends it
//! first, so no observable ordering changes.
//!
//! Backpressure: the pump forwards events through a bounded channel
//! (the backlog bound); when the consumer is behind, the pump stops
//! reading the wire — the peer's TCP window closes — instead of
//! buffering unboundedly.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use crate::command_session::{
    decode_command_session_event_response, CommandSessionEvent, EndEvent,
};
use crate::proto::{
    encode_connect_frame, ConnectFrameDecoder, CONNECT_FRAME_COMPRESSED,
    CONNECT_FRAME_END_OF_STREAM,
};
use crate::transport::{SandboxTransport, StreamedResponse, TransportRequest};
use crate::types::Method;
use crate::vm_error::CommandSessionError;
use crate::vm_process::{with_auth_retry_on, ClientInner, GatewayAuthSource};
use crate::vm_wire::{
    error_from_status_body, is_media_type, parse_end_of_stream, proto_fault, read_error_preview,
    rpc_url, stream_headers,
};

/// One queue item the stream pump produces.
pub(crate) enum StreamItem {
    Event(CommandSessionEvent),
    End(EndEvent),
    Fault(CommandSessionError),
}

/// One live command-session stream produced by
/// [`crate::CommandSessionClient::start`] or
/// [`crate::CommandSessionClient::connect`].
///
/// Call [`CommandSessionStream::release`] to detach without touching the
/// process — a later Start/Connect with the same session UUID
/// re-attaches. Dropping the handle also releases (the pump observes the
/// flag or the closed channel at its next await), but `release` is the
/// prompt, deterministic path.
#[derive(Debug)]
pub struct CommandSessionStream {
    pid: u32,
    receiver: mpsc::Receiver<StreamItem>,
    release: watch::Sender<bool>,
    pump: Option<JoinHandle<()>>,
}

impl CommandSessionStream {
    /// The guest process id from the start event.
    #[must_use]
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// True once `release` was called.
    #[must_use]
    pub fn is_released(&self) -> bool {
        *self.release.borrow()
    }

    /// Close the attachment without touching the process: no signal is
    /// sent and no further reattach is attempted. Buffered events may
    /// still drain; the stream ends afterwards. Idempotent.
    pub async fn release(&mut self) {
        let _ = self.release.send(true);
        if let Some(pump) = self.pump.take() {
            let _ = pump.await;
        }
    }

    /// The next stream event; `Ok(None)` is the end of the stream (after
    /// the end event, or after a fault).
    ///
    /// # Errors
    ///
    /// Carries the typed fault when the stream failed and the reconnect
    /// budget was exhausted.
    pub async fn next_event(&mut self) -> Option<Result<CommandSessionEvent, CommandSessionError>> {
        match self.receiver.recv().await {
            Some(StreamItem::Event(event)) => Some(Ok(event)),
            Some(StreamItem::End(end)) => Some(Ok(CommandSessionEvent::End(end))),
            Some(StreamItem::Fault(error)) => Some(Err(error)),
            None => None,
        }
    }
}

impl Drop for CommandSessionStream {
    fn drop(&mut self) {
        // Dropping the handle releases the attachment: the pump observes
        // the flag (or the dropped channel) at its next await and stops
        // reattaching.
        let _ = self.release.send(true);
    }
}

/// Spawn one stream's pump and return the unstarted handle.
/// The resolved per-stream tuning the pump carries.
pub(crate) struct PumpConfig {
    /// The encoded Start request bytes (create-or-attach re-issue).
    pub(crate) start_bytes: Vec<u8>,
    /// The encoded Connect request bytes (reattach selector).
    pub(crate) connect_bytes: Vec<u8>,
    /// Route the first open to Connect (the `connect()` entry) instead of
    /// Start.
    pub(crate) initial_route_connect: bool,
    /// Reattach budget for recoverable faults.
    pub(crate) max_reconnects: u32,
    /// Reattach backoff base: `base * 2^(n-1)`.
    pub(crate) reconnect_base_delay: Duration,
    /// `Connect-Timeout-Ms` on Start; also the sandboxd process deadline
    /// (`Some(0)` disables it; `None` inherits the server default).
    pub(crate) connect_timeout_ms: Option<u64>,
}

/// Spawn one stream's pump and return the unstarted handle.
pub(crate) fn spawn_stream<T, A>(
    inner: Arc<ClientInner<T, A>>,
    config: PumpConfig,
    max_pending_events: usize,
) -> CommandSessionStream
where
    T: SandboxTransport + 'static,
    A: GatewayAuthSource + 'static,
{
    let (events_tx, events_rx) = mpsc::channel(max_pending_events);
    let (release_tx, release_rx) = watch::channel(false);
    let pump = tokio::spawn(pump(inner, config, events_tx, release_rx));
    CommandSessionStream {
        pid: 0,
        receiver: events_rx,
        release: release_tx,
        pump: Some(pump),
    }
}

/// Resolve the stream on its first start event (TS `await
/// stream.started`); every other first outcome is a typed fault.
pub(crate) async fn await_started(
    mut stream: CommandSessionStream,
) -> Result<CommandSessionStream, CommandSessionError> {
    match stream.receiver.recv().await {
        Some(StreamItem::Event(CommandSessionEvent::Start { pid })) => {
            stream.pid = pid;
            Ok(stream)
        }
        Some(StreamItem::Event(_) | StreamItem::End(_)) => {
            Err(CommandSessionError::invalid_response(
                "Command session stream ended before its start event",
            ))
        }
        Some(StreamItem::Fault(error)) => Err(error),
        None if stream.is_released() => Err(CommandSessionError::released(
            "Process stream was released before the process ended",
        )),
        None => Err(CommandSessionError::network(
            "Process stream ended before its start event",
        )),
    }
}

// ---------------------------------------------------------------------------
// The stream pump: open, read, reattach
// ---------------------------------------------------------------------------

/// One open streaming attempt, plus the request context its errors carry.
struct OpenedStream {
    response: StreamedResponse,
    method: &'static str,
    url: String,
    /// The gateway token this attempt authenticated with; end-of-stream
    /// error messages are redacted against it.
    token: String,
}

/// The outcome of one attach attempt.
enum Attempt {
    /// The end event arrived; the session is over.
    Ended(EndEvent),
    /// A typed fault (transport, protocol, or end-of-stream error).
    Fault(CommandSessionError),
    /// The body ended cleanly without an end event (reattach).
    CleanEof,
    /// `release` fired mid-attempt.
    Released,
}

/// The pump behind one [`CommandSessionStream`]: opens Start/Connect,
/// decodes frames, forwards events through a bounded channel (the
/// backpressure bound), and reattaches on recoverable faults until the
/// budget is spent. Exactly one start event is forwarded (the first);
/// keepalives are dropped; the end event closes the stream.
///
/// Documented deviation from the TS pump: the first start event is
/// consumed by the client's `start`/`connect` call (it resolves the pid),
/// so the consumer never sees it.
async fn pump<T, A>(
    inner: Arc<ClientInner<T, A>>,
    config: PumpConfig,
    events: mpsc::Sender<StreamItem>,
    mut release: watch::Receiver<bool>,
) where
    T: SandboxTransport + 'static,
    A: GatewayAuthSource + 'static,
{
    let mut route_connect = config.initial_route_connect;
    let mut start_emitted = false;
    let mut reconnects = 0u32;
    loop {
        if *release.borrow() {
            return;
        }
        let outcome = attempt_stream(
            &inner,
            &config,
            &mut route_connect,
            &mut start_emitted,
            &events,
            &mut release,
        )
        .await;
        let recoverable = match outcome {
            Attempt::Released => return,
            Attempt::Ended(end) => {
                if !send_item(&events, &mut release, StreamItem::End(end)).await {
                    return;
                }
                return;
            }
            Attempt::Fault(fault) => fault,
            Attempt::CleanEof => {
                CommandSessionError::network("Process stream ended without an exit event")
            }
        };
        if !recoverable.is_recoverable_stream_fault() || reconnects >= config.max_reconnects {
            let _ = send_item(&events, &mut release, StreamItem::Fault(recoverable)).await;
            return;
        }
        reconnects += 1;
        let backoff = config
            .reconnect_base_delay
            .saturating_mul(1 << (reconnects - 1).min(30));
        tokio::select! {
            _ = release.changed() => return,
            () = tokio::time::sleep(backoff) => {}
        }
    }
}

/// One attach attempt: open the stream (Start before the first start
/// event, Connect after), then read frames to its end event, clean
/// end-of-stream, or fault. `release` aborts at every await.
async fn attempt_stream<T, A>(
    inner: &ClientInner<T, A>,
    config: &PumpConfig,
    route_connect: &mut bool,
    start_emitted: &mut bool,
    events: &mpsc::Sender<StreamItem>,
    release: &mut watch::Receiver<bool>,
) -> Attempt
where
    T: SandboxTransport,
    A: GatewayAuthSource,
{
    let opened = tokio::select! {
        _ = release.changed() => return Attempt::Released,
        result = open_event_stream(
            inner,
            &config.start_bytes,
            &config.connect_bytes,
            *route_connect,
            config.connect_timeout_ms,
        ) => match result {
            Ok(opened) => opened,
            Err(fault) => return Attempt::Fault(fault),
        },
    };
    let OpenedStream {
        response,
        method,
        url,
        token,
    } = opened;
    let mut decoder = match ConnectFrameDecoder::new(inner.max_event_frame_bytes) {
        Ok(decoder) => decoder,
        // Unreachable: the client validates the bound at construction.
        Err(error) => {
            return Attempt::Fault(CommandSessionError::invalid_request(error.to_string()));
        }
    };
    let mut body = response.body;
    loop {
        let chunk = tokio::select! {
            _ = release.changed() => return Attempt::Released,
            chunk = body.next_chunk() => match chunk {
                Ok(Some(chunk)) => chunk,
                Ok(None) => {
                    if decoder.buffered_len() > 0 {
                        return Attempt::Fault(CommandSessionError::network(
                            "Process stream ended mid-frame",
                        )
                        .with_context(method, url.clone(), None, None));
                    }
                    return Attempt::CleanEof;
                }
                Err(error) => {
                    return Attempt::Fault(
                        CommandSessionError::from_sandbox_error(&error)
                            .with_context(method, url.clone(), None, None),
                    );
                }
            },
        };
        decoder.push(&chunk);
        loop {
            let frame = match decoder.next_frame() {
                Ok(Some(frame)) => frame,
                Ok(None) => break,
                Err(error) => return Attempt::Fault(proto_fault(&error, method, &url)),
            };
            if frame.flags & CONNECT_FRAME_COMPRESSED != 0 {
                return Attempt::Fault(CommandSessionError::invalid_response(format!(
                    "Command session {method} sent compressed frames, which this client does not negotiate"
                ))
                .with_context(method, url.clone(), None, None));
            }
            if frame.flags & CONNECT_FRAME_END_OF_STREAM != 0 {
                return match parse_end_of_stream(&frame.payload, method, &url, &token) {
                    Ok(()) => Attempt::CleanEof,
                    Err(fault) => Attempt::Fault(fault),
                };
            }
            let event = match decode_command_session_event_response(
                &frame.payload,
                &format!("{method}Response"),
            ) {
                Ok(event) => event,
                Err(error) => return Attempt::Fault(proto_fault(&error, method, &url)),
            };
            match event {
                None | Some(CommandSessionEvent::Keepalive) => {}
                Some(CommandSessionEvent::Start { pid }) => {
                    *route_connect = true;
                    if !*start_emitted {
                        *start_emitted = true;
                        let item = StreamItem::Event(CommandSessionEvent::Start { pid });
                        if !send_item(events, release, item).await {
                            return Attempt::Released;
                        }
                    }
                }
                Some(event @ CommandSessionEvent::Data { .. }) => {
                    let item = StreamItem::Event(event);
                    if !send_item(events, release, item).await {
                        return Attempt::Released;
                    }
                }
                Some(CommandSessionEvent::End(end)) => return Attempt::Ended(end),
            }
        }
    }
}

/// Push one item through the bounded channel, aborting when `release`
/// fires or the consumer is gone; returns whether the item landed.
async fn send_item(
    events: &mpsc::Sender<StreamItem>,
    release: &mut watch::Receiver<bool>,
    item: StreamItem,
) -> bool {
    tokio::select! {
        _ = release.changed() => false,
        result = events.send(item) => result.is_ok(),
    }
}

// ---------------------------------------------------------------------------
// Open and unary requests
// ---------------------------------------------------------------------------

/// Open one streaming attempt: auth, Start-vs-Connect routing, framing,
/// and the strict content-type check.
async fn open_event_stream<T, A>(
    inner: &ClientInner<T, A>,
    start_bytes: &[u8],
    connect_bytes: &[u8],
    route_connect: bool,
    connect_timeout_ms: Option<u64>,
) -> Result<OpenedStream, CommandSessionError>
where
    T: SandboxTransport,
    A: GatewayAuthSource,
{
    let method: &'static str = if route_connect { "Connect" } else { "Start" };
    with_auth_retry_on(inner, method, |auth| async move {
        let url = rpc_url(inner, &auth, method)?;
        let payload = if route_connect {
            connect_bytes
        } else {
            start_bytes
        };
        // TS parity: `Connect-Timeout-Ms: 0` is an explicit no-deadline for
        // sandboxd, and zero also disables the local open deadline (the
        // TS fetch call converts 0 to undefined); any other value bounds
        // the open locally too.
        let open_deadline = connect_timeout_ms
            .filter(|timeout_ms| *timeout_ms != 0)
            .map(Duration::from_millis);
        let request = TransportRequest {
            method: Method::Post,
            headers: stream_headers(&auth, inner.keepalive_interval_seconds, connect_timeout_ms),
            url: url.clone(),
            body: Some(encode_connect_frame(payload, 0)),
            max_response_bytes: None,
            timeout: open_deadline,
        };
        let response = inner
            .transport
            .execute_streaming(request)
            .await
            .map_err(|error| {
                CommandSessionError::from_sandbox_error(&error).with_context(
                    method,
                    url.clone(),
                    error.status(),
                    None,
                )
            })?;
        if !(200..300).contains(&response.status) {
            let mut body = response.body;
            let text = read_error_preview(&mut body).await;
            return Err(error_from_status_body(
                response.status,
                &text,
                method,
                &url,
                &auth,
            ));
        }
        if !is_media_type(response.header("content-type"), "application/connect+proto") {
            return Err(CommandSessionError::invalid_response(format!(
                "Command session {method} must respond application/connect+proto"
            ))
            .with_context(method, url.clone(), Some(response.status), None));
        }
        Ok(OpenedStream {
            response,
            method,
            url,
            token: auth.token,
        })
    })
    .await
}
