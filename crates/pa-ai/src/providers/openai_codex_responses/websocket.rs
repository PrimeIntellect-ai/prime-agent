//! Codex WebSocket transport: connections and the per-request event loop.
//! Section of the port of
//! `packages/ai/src/providers/openai-codex-responses.ts`.
//!
//! Each connection owns a worker task that holds the socket; requests talk to
//! it over a command channel and receive events over a fresh channel per
//! request. The handshake sends the same beta header the codex-rs client
//! sends (`OpenAI-Beta: responses_websockets=2026-02-06`) plus custom
//! headers via an explicit `http::Request` (plain `connect_async` accepts
//! `http::Request`, which carries headers).

use std::sync::atomic::{AtomicU64, Ordering};

use futures::stream::SplitStream;
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::error::{CapacityError, ProtocolError};
use tokio_tungstenite::tungstenite::Error as WsError;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use tokio_util::sync::CancellationToken;

use crate::providers::openai_codex_responses::errors::{
    CodexProtocolError, CodexStreamError, WebSocketTransportError, WEBSOCKET_CLOSE_CODE_ABNORMAL,
    WEBSOCKET_CLOSE_CODE_PROTOCOL, WEBSOCKET_CLOSE_CODE_STATUS, WEBSOCKET_CLOSE_CODE_TOO_BIG,
    WEBSOCKET_CONNECTION_ENDED_REASON,
};
use crate::providers::openai_codex_responses::session::{session_state, CachedConnection};

pub const OPENAI_BETA_RESPONSES_WEBSOCKETS: &str = "responses_websockets=2026-02-06";
pub(crate) const SESSION_WEBSOCKET_CACHE_TTL_MS: u64 = 5 * 60 * 1000;

#[allow(unused_imports)] // re-exported for consumers of the transport module
pub use crate::providers::openai_codex_responses::session::{
    clear_continuation, close_websocket_sessions, is_websocket_sse_fallback_active,
    record_request_stats, record_websocket_failure, record_websocket_sse_fallback,
    schedule_session_websocket_expiry, take_continuation_for,
};

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Command sent to a connection's worker task.
pub(crate) enum WorkerCommand {
    /// Send one `response.create` request; events flow over `events`.
    Send {
        body: String,
        events: mpsc::Sender<WorkerEvent>,
    },
    Close,
}

/// Events a worker forwards to the active request.
pub enum WorkerEvent {
    /// A parsed stream event.
    Event(Value),
    /// Terminal marker after the completion event (Ok) or an error (Err).
    Terminal(Result<(), CodexStreamError>),
}

/// Connection-scoped continuation state
/// (`CachedWebSocketContinuationState` in the TS).
pub struct ContinuationState {
    pub last_request_body: Value,
    pub last_response_id: String,
    pub last_response_items: Vec<Value>,
    /// Id of the connection whose server-side response state this chain is
    /// anchored to.
    pub connection_id: u64,
}

/// Debug counters (`OpenAICodexWebSocketDebugStats` in the TS).
#[derive(Debug, Clone, Default)]
pub struct WebSocketDebugStats {
    pub requests: u64,
    pub connections_created: u64,
    pub connections_reused: u64,
    pub cached_context_requests: u64,
    pub store_true_requests: u64,
    pub full_context_requests: u64,
    pub delta_requests: u64,
    pub last_input_items: u64,
    pub last_delta_input_items: Option<u64>,
    pub last_previous_response_id: Option<String>,
    pub websocket_failures: u64,
    pub sse_fallbacks: u64,
    pub websocket_fallback_active: Option<bool>,
    pub last_websocket_error: Option<String>,
}

fn next_connection_id() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::SeqCst)
}

/// Port of the TS runtime's (bun) WebSocket connect-failure surface,
/// probe-verified against the TS binary: every connect-phase failure is a
/// plain `Error` whose message is `WebSocket connection to '<url>' failed:
/// <cause>` with the runtime's own cause texts — `Failed to connect` for
/// socket-level failures, `Expected 101 status code` for a non-101 answer,
/// `Mismatch websocket accept header` for a bad accept key, and
/// `TLS handshake failed` for TLS failures.
fn bun_connect_failure(url: &str, error: WsError) -> WebSocketTransportError {
    let cause = match &error {
        WsError::Io(io) => {
            // tokio-tungstenite surfaces the rustls handshake failure as a
            // plain io error, so on wss URLs any socket failure after the
            // refused connect maps to the runtime's TLS-handshake text
            // (probe-verified against a plain-speaking wss peer).
            if url.starts_with("wss://")
                && !matches!(
                    io.kind(),
                    std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::TimedOut
                )
            {
                "TLS handshake failed".to_string()
            } else {
                "Failed to connect".to_string()
            }
        }
        WsError::Tls(_) => "TLS handshake failed".to_string(),
        WsError::Http(_) => "Expected 101 status code".to_string(),
        // The runtime checks the status code before the HTTP shape, so a
        // response the transport rejects for its version or method carries
        // the same non-101 text.
        WsError::Protocol(ProtocolError::WrongHttpVersion | ProtocolError::WrongHttpMethod) => {
            "Expected 101 status code".to_string()
        }
        WsError::Protocol(ProtocolError::SecWebSocketAcceptKeyMismatch) => {
            "Mismatch websocket accept header".to_string()
        }
        other => other.to_string(),
    };
    WebSocketTransportError::runtime(format!("WebSocket connection to '{url}' failed: {cause}"))
}

/// Port of the TS runtime's (bun) WebSocket read-failure surface,
/// probe-verified against the TS binary: every socket or frame failure
/// surfaces as a close event composing `WebSocket closed {code} {reason}` —
/// code 1006 (`Connection ended`) for socket death, per-case codes for frame
/// violations (1002 `Protocol error - unsupported control frame` for
/// reserved opcodes, 1011 `Compression not implemented yet` for reserved
/// bits). Unprobed violations compose the runtime's protocol-error envelope
/// with the transport's own detail text.
fn bun_read_failure(error: WsError) -> WebSocketTransportError {
    match &error {
        // The transport's EOF-without-close-frame error is the same socket
        // death the runtime reports as the 1006 close event.
        WsError::Protocol(ProtocolError::ResetWithoutClosingHandshake) => {
            WebSocketTransportError::close(
                WEBSOCKET_CLOSE_CODE_ABNORMAL,
                WEBSOCKET_CONNECTION_ENDED_REASON,
            )
        }
        WsError::Capacity(CapacityError::MessageTooLong { .. }) => {
            WebSocketTransportError::close(WEBSOCKET_CLOSE_CODE_TOO_BIG, "")
        }
        WsError::Io(_)
        | WsError::ConnectionClosed
        | WsError::AlreadyClosed
        | WsError::WriteBufferFull(_)
        | WsError::Capacity(_) => WebSocketTransportError::close(
            WEBSOCKET_CLOSE_CODE_ABNORMAL,
            WEBSOCKET_CONNECTION_ENDED_REASON,
        ),
        WsError::Protocol(ProtocolError::NonZeroReservedBits) => {
            WebSocketTransportError::close(1011, "Compression not implemented yet")
        }
        WsError::Protocol(
            ProtocolError::InvalidOpcode(_)
            | ProtocolError::UnknownDataFrameType(_)
            | ProtocolError::UnknownControlFrameType(_),
        ) => WebSocketTransportError::close(
            WEBSOCKET_CLOSE_CODE_PROTOCOL,
            "Protocol error - unsupported control frame",
        ),
        WsError::Protocol(other) => WebSocketTransportError::close(
            WEBSOCKET_CLOSE_CODE_PROTOCOL,
            &format!("Protocol error - {other}"),
        ),
        other => WebSocketTransportError::close(
            WEBSOCKET_CLOSE_CODE_PROTOCOL,
            &format!("Protocol error - {other}"),
        ),
    }
}

/// Port of `connectWebSocket` + worker spawn: handshake with custom headers,
/// then run the reader loop until the channel closes.
/// Port of `connectWebSocket` + worker spawn: handshake with custom headers,
/// then run the reader loop until the channel closes.
async fn spawn_connection_worker(
    url: &str,
    headers: &[(String, String)],
    signal: Option<CancellationToken>,
) -> Result<(mpsc::Sender<WorkerCommand>, u64), CodexStreamError> {
    let mut request = url.into_client_request().map_err(|error| {
        CodexStreamError::Transport(WebSocketTransportError::runtime(format!(
            "WebSocket connection to '{url}' failed: {error}"
        )))
    })?;
    for (name, value) in headers {
        let name = http::HeaderName::from_bytes(name.as_bytes()).map_err(|_| {
            CodexStreamError::Transport(WebSocketTransportError::runtime(format!(
                "WebSocket connection to '{url}' failed: Invalid WebSocket header {name}"
            )))
        })?;
        let value = http::HeaderValue::from_str(value).map_err(|_| {
            CodexStreamError::Transport(WebSocketTransportError::runtime(format!(
                "WebSocket connection to '{url}' failed: Invalid WebSocket header value"
            )))
        })?;
        request.headers_mut().insert(name, value);
    }

    if signal
        .as_ref()
        .is_some_and(tokio_util::sync::CancellationToken::is_cancelled)
    {
        return Err(CodexStreamError::Aborted);
    }

    let connect = tokio_tungstenite::connect_async(request);
    let (stream, _response) = match signal.as_ref() {
        Some(signal) => {
            tokio::select! {
                () = signal.cancelled() => return Err(CodexStreamError::Aborted),
                result = connect => result,
            }
        }
        None => connect.await,
    }
    .map_err(|error| CodexStreamError::Transport(bun_connect_failure(url, error)))?;

    let connection_id = next_connection_id();
    let (command_tx, command_rx) = mpsc::channel::<WorkerCommand>(4);
    tokio::spawn(connection_worker(stream, command_rx, signal));
    Ok((command_tx, connection_id))
}

/// Port of `parseWebSocket`: per-request event forwarding with completion
/// tracking, error extraction, and close-code reporting. The worker parks
/// between requests so a session can reuse one connection.
/// Port of `parseWebSocket`: per-request event forwarding with completion
/// tracking, error extraction, and close-code reporting. The worker parks
/// between requests so a session can reuse one connection.
async fn connection_worker(
    stream: WsStream,
    mut commands: mpsc::Receiver<WorkerCommand>,
    signal: Option<CancellationToken>,
) {
    let (mut sink, mut stream) = stream.split();
    loop {
        let Some(command) = commands.recv().await else {
            return;
        };
        match command {
            WorkerCommand::Close => {
                let _ = sink.close().await;
                return;
            }
            WorkerCommand::Send { body, events } => {
                if sink.send(Message::Text(body.into())).await.is_err() {
                    // A dead socket surfaces through its close event (the TS
                    // runtime's send on a closed socket is a silent no-op; the
                    // close event carries the failure).
                    let _ = events
                        .send(WorkerEvent::Terminal(Err(CodexStreamError::Transport(
                            WebSocketTransportError::close(
                                WEBSOCKET_CLOSE_CODE_ABNORMAL,
                                WEBSOCKET_CONNECTION_ENDED_REASON,
                            ),
                        ))))
                        .await;
                    let _ = sink.close().await;
                    return;
                }
                let terminal = read_request_events(&mut stream, &events, &signal).await;
                if terminal.is_err() {
                    let _ = events.send(WorkerEvent::Terminal(terminal)).await;
                    let _ = sink.close().await;
                    return;
                }
                let _ = events.send(WorkerEvent::Terminal(terminal)).await;
            }
        }
    }
}

/// Read one request's events until completion, close, or error.
async fn read_request_events(
    stream: &mut SplitStream<WsStream>,
    events: &mpsc::Sender<WorkerEvent>,
    signal: &Option<CancellationToken>,
) -> Result<(), CodexStreamError> {
    let mut saw_completion = false;
    loop {
        if signal
            .as_ref()
            .is_some_and(tokio_util::sync::CancellationToken::is_cancelled)
        {
            return Err(CodexStreamError::Aborted);
        }
        let next = stream.next();
        let message = match signal.as_ref() {
            Some(signal) => {
                tokio::select! {
                    () = signal.cancelled() => return Err(CodexStreamError::Aborted),
                    message = next => message,
                }
            }
            None => next.await,
        };
        match message {
            // Peer EOF without a close frame: the runtime fires a close event
            // with code 1006 ("Connection ended" in the TS runtime).
            None => {
                return Err(CodexStreamError::Transport(WebSocketTransportError::close(
                    WEBSOCKET_CLOSE_CODE_ABNORMAL,
                    WEBSOCKET_CONNECTION_ENDED_REASON,
                )));
            }
            Some(Ok(Message::Text(text))) => {
                let text = text.as_str().to_string();
                match serde_json::from_str::<Value>(&text) {
                    Ok(event) => {
                        let event_type = event.get("type").and_then(Value::as_str);
                        if matches!(
                            event_type,
                            Some("response.completed" | "response.done" | "response.incomplete")
                        ) {
                            saw_completion = true;
                        }
                        if events.send(WorkerEvent::Event(event)).await.is_err() {
                            // The request consumer is gone (its receiver was
                            // dropped); nobody observes this text.
                            return Err(CodexStreamError::Transport(
                                WebSocketTransportError::runtime("WebSocket request cancelled"),
                            ));
                        }
                        if saw_completion {
                            return Ok(());
                        }
                    }
                    // Port of `parseWebSocket`'s JSON failure: a non-transport
                    // protocol error, thrown without SSE fallback.
                    Err(error) => {
                        return Err(CodexStreamError::Protocol(CodexProtocolError {
                            message: format!("Invalid Codex WebSocket JSON: {error}"),
                            payload: Some(Value::String(text)),
                        }));
                    }
                }
            }
            Some(Ok(Message::Binary(bytes))) => {
                // Codex events are JSON text; binary frames decode as UTF-8.
                let text = String::from_utf8_lossy(&bytes).to_string();
                match serde_json::from_str::<Value>(&text) {
                    Ok(event) => {
                        if events.send(WorkerEvent::Event(event)).await.is_err() {
                            return Err(CodexStreamError::Transport(
                                WebSocketTransportError::runtime("WebSocket request cancelled"),
                            ));
                        }
                    }
                    Err(error) => {
                        return Err(CodexStreamError::Protocol(CodexProtocolError {
                            message: format!("Invalid Codex WebSocket JSON: {error}"),
                            payload: Some(Value::String(text)),
                        }));
                    }
                }
            }
            Some(Ok(Message::Close(close))) => {
                if saw_completion {
                    return Ok(());
                }
                // A close frame without a status code surfaces as the
                // runtime's 1005 close event (probe-verified).
                let error = match close {
                    Some(frame) => {
                        WebSocketTransportError::close(u16::from(frame.code), frame.reason.as_str())
                    }
                    None => WebSocketTransportError::close(WEBSOCKET_CLOSE_CODE_STATUS, ""),
                };
                return Err(CodexStreamError::Transport(error));
            }
            Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => {}
            Some(Err(error)) => {
                return Err(CodexStreamError::Transport(bun_read_failure(error)));
            }
        }
    }
}

/// A session-acquired connection handle (`{ socket, entry, reused, release }`).
pub struct AcquiredConnection {
    worker: mpsc::Sender<WorkerCommand>,
    pub session_id: Option<String>,
    pub reused: bool,
    /// A cache entry backs this connection (continuation is possible).
    pub cached: bool,
    pub connection_id: u64,
}

impl AcquiredConnection {
    /// Send the `response.create` request and return the event channel.
    pub async fn send_request(
        &self,
        body: &Value,
        signal: Option<CancellationToken>,
    ) -> Result<mpsc::Receiver<WorkerEvent>, CodexStreamError> {
        if signal
            .as_ref()
            .is_some_and(tokio_util::sync::CancellationToken::is_cancelled)
        {
            return Err(CodexStreamError::Aborted);
        }
        let mut request = body.clone();
        request["type"] = Value::String("response.create".to_string());
        let (event_tx, event_rx) = mpsc::channel(64);
        self.worker
            .send(WorkerCommand::Send {
                body: request.to_string(),
                events: event_tx,
            })
            .await
            .map_err(|_| {
                // The worker (socket) is gone; in the TS the socket's close
                // event would surface with the 1006 close text.
                CodexStreamError::Transport(WebSocketTransportError::close(
                    WEBSOCKET_CLOSE_CODE_ABNORMAL,
                    WEBSOCKET_CONNECTION_ENDED_REASON,
                ))
            })?;
        Ok(event_rx)
    }

    /// Port of `closeWebSocketSilently`: ask the worker to close the socket.
    pub async fn close(&self) {
        let _ = self.worker.send(WorkerCommand::Close).await;
    }
}

/// Port of `isWebSocketSseFallbackActive`.
/// Port of `acquireWebSocket`: reuse the session's idle connection when
/// possible, otherwise open a fresh connection (cached per session).
pub async fn acquire_websocket(
    url: &str,
    headers: &[(String, String)],
    session_id: Option<&str>,
    signal: Option<CancellationToken>,
) -> Result<AcquiredConnection, CodexStreamError> {
    let Some(session_id) = session_id else {
        // No session: uncached one-shot connection, closed after the request.
        let (worker, connection_id) = spawn_connection_worker(url, headers, signal).await?;
        return Ok(AcquiredConnection {
            worker,
            session_id: None,
            reused: false,
            cached: false,
            connection_id,
        });
    };

    // Reuse the session's idle connection.
    let cached_worker = {
        let mut state = session_state().lock().ok();
        match state
            .as_mut()
            .and_then(|state| state.connections.get_mut(session_id))
        {
            Some(entry) if !entry.busy => {
                entry.busy = true;
                entry.expiry_generation += 1;
                Some((entry.worker.clone(), entry.connection_id))
            }
            _ => None,
        }
    };
    if let Some((worker, connection_id)) = cached_worker {
        return Ok(AcquiredConnection {
            worker,
            session_id: Some(session_id.to_string()),
            reused: true,
            cached: true,
            connection_id,
        });
    }

    // Fresh connection: cache it for the session unless an entry is busy.
    let entry_busy = session_state().lock().is_ok_and(|state| {
        state
            .connections
            .get(session_id)
            .is_some_and(|entry| entry.busy)
    });
    let (worker, connection_id) = spawn_connection_worker(url, headers, signal).await?;

    let cached = if entry_busy {
        false
    } else {
        let Ok(mut state) = session_state().lock() else {
            return Ok(AcquiredConnection {
                worker,
                session_id: Some(session_id.to_string()),
                reused: false,
                cached: false,
                connection_id,
            });
        };
        state.connections.insert(
            session_id.to_string(),
            CachedConnection {
                worker: worker.clone(),
                busy: true,
                continuation: None,
                expiry_generation: 0,
                connection_id,
            },
        );
        true
    };

    Ok(AcquiredConnection {
        worker,
        session_id: Some(session_id.to_string()),
        reused: false,
        cached,
        connection_id,
    })
}

/// Port of `release`: return the connection to the cache with its new
/// continuation state, or close it. `keep` mirrors the TS `{ keep }` option.
/// Port of `release`: return the connection to the cache with its new
/// continuation state, or close it. `keep` mirrors the TS `{ keep }` option.
pub async fn release_connection(
    connection: AcquiredConnection,
    keep: bool,
    continuation: Option<ContinuationState>,
) {
    let session_id = connection.session_id.clone();
    let Some(session_id) = session_id else {
        // Uncached connections always close after the request.
        connection.close().await;
        return;
    };
    if !keep {
        close_websocket_sessions(Some(&session_id));
        return;
    }
    let matched = match session_state().lock() {
        Ok(mut state) => match state.connections.get_mut(&session_id) {
            Some(entry) if entry.connection_id == connection.connection_id => {
                entry.busy = false;
                entry.continuation = continuation;
                true
            }
            _ => false,
        },
        Err(_) => false,
    };
    if matched {
        schedule_session_websocket_expiry(&session_id);
    } else {
        connection.close().await;
    }
}

/// Port of `scheduleSessionWebSocketExpiry`: close the cached connection
/// after the TTL if it stayed idle.
/// Port of `requestBodiesMatchExceptInput` + `getCachedWebSocketInputDelta`:
/// compute the continuation delta (input items beyond the cached baseline)
/// for an otherwise-identical request body.
pub fn get_cached_websocket_input_delta(
    body: &Value,
    continuation: &ContinuationState,
) -> Option<Vec<Value>> {
    let strip = |value: &Value| -> Value {
        let mut stripped = value.clone();
        if let Some(map) = stripped.as_object_mut() {
            map.remove("input");
            map.remove("previous_response_id");
        }
        stripped
    };
    if strip(body) != strip(&continuation.last_request_body) {
        return None;
    }
    let current_input = body.get("input").and_then(Value::as_array).cloned()?;
    let last_input = continuation
        .last_request_body
        .get("input")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut baseline = last_input;
    baseline.extend(continuation.last_response_items.iter().cloned());
    if current_input.len() < baseline.len() {
        return None;
    }
    let prefix = &current_input[..baseline.len()];
    if prefix != baseline.as_slice() {
        return None;
    }
    Some(current_input[baseline.len()..].to_vec())
}

/// Port of `buildCachedWebSocketRequestBody`.
pub fn build_cached_websocket_request_body(
    continuation: Option<&ContinuationState>,
    body: &Value,
    connection_id: u64,
) -> Value {
    let Some(continuation) = continuation else {
        return body.clone();
    };
    // Continuations are anchored to the connection that produced the
    // response; a different socket cannot resolve their previous_response_id.
    if continuation.connection_id != connection_id {
        return body.clone();
    }
    let delta = get_cached_websocket_input_delta(body, continuation);
    match delta {
        Some(delta) if !continuation.last_response_id.is_empty() => {
            let mut request = body.clone();
            request["previous_response_id"] = json!(continuation.last_response_id);
            request["input"] = Value::Array(delta);
            request
        }
        _ => body.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn continuation(last_body: Value, items: Vec<Value>) -> ContinuationState {
        ContinuationState {
            last_request_body: last_body,
            last_response_id: "resp_1".to_string(),
            last_response_items: items,
            connection_id: 42,
        }
    }

    #[test]
    fn computes_input_delta_for_matching_bodies() {
        let base = json!({ "model": "gpt", "input": [ { "type": "a" } ] });
        let items = vec![json!({ "type": "assistant_item" })];
        let cont = continuation(base, items);
        let next = json!({
            "model": "gpt",
            "input": [ { "type": "a" }, { "type": "assistant_item" }, { "type": "new" } ],
        });
        let request = build_cached_websocket_request_body(Some(&cont), &next, 42);
        assert_eq!(request["previous_response_id"], "resp_1");
        assert_eq!(request["input"], json!([{ "type": "new" }]));
    }

    #[test]
    fn rejects_delta_when_body_differs() {
        let base = json!({ "model": "gpt", "input": [ { "type": "a" } ] });
        let cont = continuation(base, vec![]);
        let next = json!({ "model": "other", "input": [ { "type": "a" }, { "type": "b" } ] });
        let request = build_cached_websocket_request_body(Some(&cont), &next, 42);
        assert!(request.get("previous_response_id").is_none());
        assert_eq!(request["input"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn rejects_delta_when_prefix_differs() {
        let base = json!({ "model": "gpt", "input": [ { "type": "a" } ] });
        let cont = continuation(base, vec![json!({ "type": "x" })]);
        let next = json!({ "model": "gpt", "input": [ { "type": "a" }, { "type": "y" } ] });
        let request = build_cached_websocket_request_body(Some(&cont), &next, 42);
        assert!(request.get("previous_response_id").is_none());
    }

    #[test]
    fn rejects_continuation_from_other_connection() {
        let base = json!({ "model": "gpt", "input": [] });
        let cont = continuation(base.clone(), vec![]);
        let request = build_cached_websocket_request_body(Some(&cont), &base, 7);
        assert!(request.get("previous_response_id").is_none());
    }
}

/// Raw-socket WebSocket mocks for the transport tests: one connection, one
/// scripted wire sequence per scenario (the `provider_error` probe drives the
/// TS binary through the same sequences; these pin the texts and the
/// diagnostic error surface in-crate).
#[cfg(test)]
mod ws_wire_tests {
    use super::*;
    use crate::providers::openai_codex_responses::errors::{
        WebSocketTransportError, WEBSOCKET_CLOSE_CODE_ABNORMAL,
    };
    use base64::Engine as _;
    use sha1::Digest as _;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    const OP_TEXT: u8 = 0x1;
    const OP_CLOSE: u8 = 0x8;

    /// The scripted wire sequence the mock serves after the handshake
    /// request is read.
    enum MockAction {
        /// Answer the upgrade request with a plain HTTP error.
        RejectHttp(u16),
        /// Complete the 101 handshake with a wrong Sec-WebSocket-Accept.
        BadAcceptKey,
        /// Send a close frame with code + reason, then FIN.
        CloseCode { code: u16, reason: &'static str },
        /// Send a close frame with no status code, then FIN.
        CloseNoCode,
        /// Close the TCP connection without a close frame.
        Fin,
        /// Send a reserved data-opcode frame (0x3).
        ReservedDataOpcode,
        /// Send a reserved control-opcode frame (0xB).
        ReservedControlOpcode,
        /// Send a text frame with RSV1 set.
        RsvBits,
        /// Send a non-JSON text frame.
        InvalidJson,
    }

    async fn read_http_head(socket: &mut TcpStream) -> String {
        let mut buf: Vec<u8> = Vec::new();
        loop {
            let mut chunk = [0u8; 512];
            let read = socket.read(&mut chunk).await.expect("mock read");
            assert!(read > 0, "client closed before the request head");
            buf.extend_from_slice(&chunk[..read]);
            if buf.windows(4).any(|window| window == b"\r\n\r\n") {
                return String::from_utf8_lossy(&buf).to_string();
            }
        }
    }

    fn header_value(head: &str, name: &str) -> Option<String> {
        head.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.trim()
                .eq_ignore_ascii_case(name)
                .then(|| value.trim().to_string())
        })
    }

    fn ws_frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
        let mut frame = vec![0x80 | opcode];
        assert!(payload.len() < 126, "mock frames are small");
        frame.push(payload.len() as u8);
        frame.extend_from_slice(payload);
        frame
    }

    async fn spawn_ws_mock(action: MockAction) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("mock bind");
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("mock accept");
            let head = read_http_head(&mut socket).await;
            let key = header_value(&head, "sec-websocket-key").expect("upgrade key");
            if let MockAction::RejectHttp(status) = action {
                let reason = http::StatusCode::from_u16(status)
                    .ok()
                    .and_then(|status| status.canonical_reason())
                    .unwrap_or("Error");
                socket
                    .write_all(
                        format!("HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\n\r\n")
                            .as_bytes(),
                    )
                    .await
                    .expect("mock write");
                socket.shutdown().await.ok();
                return;
            }
            let accept = if matches!(action, MockAction::BadAcceptKey) {
                "aW52YWxpZA==".to_string()
            } else {
                base64::engine::general_purpose::STANDARD
                    .encode(sha1::Sha1::digest(format!("{key}{WS_GUID}").as_bytes()))
            };
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .expect("mock write");
            // The client sends its response.create; give it time to arrive.
            tokio::time::sleep(Duration::from_millis(50)).await;
            match action {
                MockAction::CloseCode { code, reason } => {
                    let mut payload = code.to_be_bytes().to_vec();
                    payload.extend_from_slice(reason.as_bytes());
                    socket
                        .write_all(&ws_frame(OP_CLOSE, &payload))
                        .await
                        .unwrap();
                    socket.shutdown().await.ok();
                }
                MockAction::CloseNoCode => {
                    socket.write_all(&ws_frame(OP_CLOSE, &[])).await.unwrap();
                    socket.shutdown().await.ok();
                }
                MockAction::Fin => {
                    socket.shutdown().await.ok();
                }
                MockAction::ReservedDataOpcode => {
                    socket.write_all(&[0x83, 0x00]).await.unwrap();
                    socket.shutdown().await.ok();
                }
                MockAction::ReservedControlOpcode => {
                    socket.write_all(&[0x8B, 0x00]).await.unwrap();
                    socket.shutdown().await.ok();
                }
                MockAction::RsvBits => {
                    socket.write_all(&[0xC1, 0x00]).await.unwrap();
                    socket.shutdown().await.ok();
                }
                MockAction::InvalidJson => {
                    socket
                        .write_all(&ws_frame(OP_TEXT, b"not json"))
                        .await
                        .unwrap();
                    socket.shutdown().await.ok();
                }
                MockAction::RejectHttp(_) | MockAction::BadAcceptKey => {}
            }
            // Hold the socket so the failure reaches the client cleanly.
            tokio::time::sleep(Duration::from_millis(200)).await;
        });
        format!("ws://127.0.0.1:{port}/codex/responses")
    }

    /// Drive one acquire+send+read cycle and return the terminal transport
    /// error (the read loop surfaces it after the scripted wire sequence).
    async fn request_terminal_error(action: MockAction) -> CodexStreamError {
        let url = spawn_ws_mock(action).await;
        let connection = acquire_websocket(&url, &[], None, None)
            .await
            .expect("handshake succeeds");
        let mut events = connection
            .send_request(&serde_json::json!({ "model": "gpt" }), None)
            .await
            .expect("request sent");
        loop {
            match events.recv().await.expect("worker stays alive") {
                WorkerEvent::Event(_) => {}
                WorkerEvent::Terminal(result) => return result.expect_err("scripted failure"),
            }
        }
    }

    /// Drive one acquire against a mock that fails before the handshake
    /// completes and return the connect-phase error.
    async fn acquire_connect_error(action: MockAction) -> WebSocketTransportError {
        let url = spawn_ws_mock(action).await;
        match acquire_websocket(&url, &[], None, None).await {
            Ok(_) => panic!("expected the connect phase to fail"),
            Err(CodexStreamError::Transport(error)) => error,
            Err(other) => panic!("expected a transport error, got {other}"),
        }
    }

    /// A refused connect (the probe's dead port): the runtime's own
    /// connect-failure envelope with the "Failed to connect" cause and a
    /// plain `Error` name (TS-binary verified).
    #[tokio::test]
    async fn refused_connect_text() {
        let url = "ws://127.0.0.1:1/codex/responses".to_string();
        let error = match acquire_websocket(&url, &[], None, None).await {
            Ok(_) => panic!("expected the dead port to fail"),
            Err(CodexStreamError::Transport(error)) => error,
            Err(other) => panic!("expected a transport error, got {other}"),
        };
        assert_eq!(
            error.to_string(),
            "WebSocket connection to 'ws://127.0.0.1:1/codex/responses' failed: Failed to connect"
        );
        assert_eq!(error.error_name(), "Error");
        assert_eq!(error.close_code(), None);
    }

    /// A non-101 upgrade answer: the "Expected 101 status code" cause
    /// (TS-binary verified for 401 and 500).
    #[tokio::test]
    async fn handshake_rejection_text() {
        for status in [401u16, 500u16] {
            let error = acquire_connect_error(MockAction::RejectHttp(status)).await;
            assert!(
                error
                    .to_string()
                    .starts_with("WebSocket connection to 'ws://127.0.0.1:"),
                "unexpected text {error}"
            );
            assert!(
                error
                    .to_string()
                    .ends_with("/codex/responses' failed: Expected 101 status code"),
                "unexpected text {error}"
            );
            assert_eq!(error.error_name(), "Error");
        }
    }

    /// A wrong Sec-WebSocket-Accept: the "Mismatch websocket accept header"
    /// cause (TS-binary verified).
    #[tokio::test]
    async fn bad_accept_key_text() {
        let error = acquire_connect_error(MockAction::BadAcceptKey).await;
        assert!(error
            .to_string()
            .ends_with("/codex/responses' failed: Mismatch websocket accept header"));
        assert_eq!(error.error_name(), "Error");
    }

    /// A close frame with code + reason: `WebSocket closed {code} {reason}`
    /// with the `WebSocketCloseError` name and the numeric code the
    /// diagnostic records (TS-binary verified).
    #[tokio::test]
    async fn close_frame_with_reason_text() {
        let error = request_terminal_error(MockAction::CloseCode {
            code: 1011,
            reason: "mock server reason",
        })
        .await;
        let CodexStreamError::Transport(transport) = &error else {
            panic!("expected a transport error, got {error}");
        };
        assert_eq!(
            transport.to_string(),
            "WebSocket closed 1011 mock server reason"
        );
        assert_eq!(transport.error_name(), "WebSocketCloseError");
        assert_eq!(transport.close_code(), Some(1011));
    }

    /// The 1009 no-reason special case composes "message too big"
    /// (TS-binary verified).
    #[tokio::test]
    async fn close_1009_no_reason_text() {
        let error = request_terminal_error(MockAction::CloseCode {
            code: WEBSOCKET_CLOSE_CODE_TOO_BIG,
            reason: "",
        })
        .await;
        let CodexStreamError::Transport(transport) = &error else {
            panic!("expected a transport error, got {error}");
        };
        assert_eq!(
            transport.to_string(),
            "WebSocket closed 1009 message too big"
        );
        assert_eq!(transport.close_code(), Some(1009));
    }

    /// A close frame without a status code surfaces as the runtime's 1005
    /// close event (TS-binary verified).
    #[tokio::test]
    async fn close_no_code_text() {
        let error = request_terminal_error(MockAction::CloseNoCode).await;
        let CodexStreamError::Transport(transport) = &error else {
            panic!("expected a transport error, got {error}");
        };
        assert_eq!(transport.to_string(), "WebSocket closed 1005");
        assert_eq!(transport.close_code(), Some(1005));
    }

    /// A TCP close without a close frame: code 1006 "Connection ended"
    /// (TS-binary verified for both FIN and RST).
    #[tokio::test]
    async fn fin_without_close_frame_text() {
        let error = request_terminal_error(MockAction::Fin).await;
        let CodexStreamError::Transport(transport) = &error else {
            panic!("expected a transport error, got {error}");
        };
        assert_eq!(
            transport.to_string(),
            "WebSocket closed 1006 Connection ended"
        );
        assert_eq!(transport.error_name(), "WebSocketCloseError");
        assert_eq!(transport.close_code(), Some(WEBSOCKET_CLOSE_CODE_ABNORMAL));
    }

    /// Reserved opcodes (data or control): code 1002 with the runtime's
    /// protocol-error reason (TS-binary verified).
    #[tokio::test]
    async fn reserved_opcode_text() {
        for action in [
            MockAction::ReservedDataOpcode,
            MockAction::ReservedControlOpcode,
        ] {
            let error = request_terminal_error(action).await;
            let CodexStreamError::Transport(transport) = &error else {
                panic!("expected a transport error, got {error}");
            };
            assert_eq!(
                transport.to_string(),
                "WebSocket closed 1002 Protocol error - unsupported control frame"
            );
            assert_eq!(transport.close_code(), Some(1002));
        }
    }

    /// Reserved bits on a frame: the runtime's 1011 "Compression not
    /// implemented yet" close (TS-binary verified).
    #[tokio::test]
    async fn rsv_bits_text() {
        let error = request_terminal_error(MockAction::RsvBits).await;
        let CodexStreamError::Transport(transport) = &error else {
            panic!("expected a transport error, got {error}");
        };
        assert_eq!(
            transport.to_string(),
            "WebSocket closed 1011 Compression not implemented yet"
        );
        assert_eq!(transport.close_code(), Some(1011));
    }

    /// A wss peer that speaks no TLS: the runtime's "TLS handshake failed"
    /// cause (TS-binary verified).
    #[tokio::test]
    async fn wss_to_plain_tls_text() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("mock bind");
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("mock accept");
            // Read the TLS ClientHello then answer plain HTTP: the handshake
            // fails against a non-TLS peer.
            let mut buf = [0u8; 512];
            let _ = socket.read(&mut buf).await;
            socket
                .write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n")
                .await
                .expect("mock write");
        });
        let url = format!("wss://127.0.0.1:{port}/codex/responses");
        let error = match acquire_websocket(&url, &[], None, None).await {
            Ok(_) => panic!("expected the TLS handshake to fail"),
            Err(CodexStreamError::Transport(error)) => error,
            Err(other) => panic!("expected a transport error, got {other}"),
        };
        assert_eq!(
            error.to_string(),
            format!("WebSocket connection to 'wss://127.0.0.1:{port}/codex/responses' failed: TLS handshake failed")
        );
        assert_eq!(error.error_name(), "Error");
    }

    /// An invalid JSON frame is a non-transport protocol error (`isCodexNonTransportError`
    /// in the TS): it throws without the SSE fallback, surfacing the
    /// `CodexProtocolError` name in the `provider_stream_failure` diagnostic.
    #[tokio::test]
    async fn invalid_json_is_non_transport_error() {
        let error = request_terminal_error(MockAction::InvalidJson).await;
        assert!(error.is_non_transport_error(), "expected a protocol error");
        assert!(
            error
                .to_string()
                .starts_with("Invalid Codex WebSocket JSON: "),
            "unexpected text {error}"
        );
    }
}
