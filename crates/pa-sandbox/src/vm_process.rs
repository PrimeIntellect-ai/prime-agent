//! `ConnectRPC` client for the sandboxd `command_session` service (VM
//! sandboxes only), spoken over the sandbox gateway's authenticated
//! `/{user_ns}/{job_id}` path with the sandbox-bound gateway token.
//! Port of `vm-process-client.ts` (TS branch `feat/direct-cloud-sandbox`).
//!
//! This is the raw process API the cloud-delegation plan needs, not a
//! subprocess wrapper: a Start with a caller-supplied session UUID is
//! create-or-attach (re-issuing the identical request attaches to the
//! session or replays its retained end event — never a second process),
//! so a caller can confirm a resident launch and then
//! [`CommandSessionStream::release`] the transport without terminating
//! the process it started. There is no `close()` that signals: the only
//! ways to affect the process are the explicit SendInput/SendSignal/Update
//! RPCs.
//!
//! Wire contract (verified against platform source, sandboxd process
//! service and the sandbox gateway):
//! - unary RPCs (SendInput/SendSignal/Update): `POST
//!   {gateway}/{ns}/{job}/command_session.CommandSession/{Method}`,
//!   request body `application/proto`, response body the empty response
//!   message;
//! - server-streaming RPCs (Start/Connect): request body one enveloped
//!   frame (`application/connect+proto`), response frames of
//!   StartResponse/ConnectResponse events, terminated by an end-of-stream
//!   JSON frame;
//! - errors: Connect JSON bodies (`{"code","message"}`) win;
//!   gateway-shaped bodies (`{"error","message"}`) and bare statuses fall
//!   back to an HTTP-status map. 401/unauthenticated re-auths exactly once
//!   per operation;
//! - `Connect-Timeout-Ms` on Start also bounds the remote process
//!   (sandboxd reads it as the process deadline; `0` disables the
//!   deadline). Reattach attempts do not extend the deadline the first
//!   Start set;
//! - `Keepalive-Ping-Interval` (seconds) paces sandboxd's keepalive
//!   events, which keep long-lived attachment streams from being reaped
//!   as idle.
//!
//! Safety contract (TS parity): the gateway token never appears in URLs,
//! error messages, or previews; every frame and body is bounded; oversize
//! frames abort the stream; responses are strictly decoded (malformed
//! input is a typed `invalid_response`, never a silent default); control
//! RPCs resend byte-identical requests across retries, and input and
//! signal UUIDs make duplicates at-most-once on the server.
//!
//! The stream half — the live event pump, its reattach budget, and the
//! release path — lives in [`crate::vm_stream`]; the pure wire helpers
//! live in [`crate::vm_wire`]. A reviewed deviation from the TS module:
//! [`CommandSessionClient::start`]/[`CommandSessionClient::connect`]
//! resolve once the start event arrives (the pid is on the stream) and
//! the consumer never re-receives that event (see `vm_stream` for the
//! rationale).

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use uuid::Uuid;

use crate::command_session::{
    encode_connect_request, encode_send_input_request, encode_send_signal_request,
    encode_start_request, encode_update_request, InputChannel, PtySize, StartRequest, VmSignal,
};
use crate::gateway::{GatewayAuth, GatewayOptions};
use crate::proto::{ProtoError, ProtoErrorKind};
use crate::transport::{SandboxTransport, TransportRequest};
use crate::types::Method;
use crate::vm_error::{CommandSessionError, CommandSessionErrorCode};
use crate::vm_stream::{await_started, spawn_stream, CommandSessionStream, PumpConfig};
use crate::vm_wire::{
    decode_empty_message, error_from_status_body, is_media_type, read_error_preview, rpc_url,
    unary_headers,
};

/// Input write bound (the platform's documented process-input cap, TS
/// `MAX_PROCESS_INPUT_BYTES`).
pub const MAX_PROCESS_INPUT_BYTES: usize = 1024 * 1024;

/// Default hard cap on a single streaming frame (TS
/// `DEFAULT_EVENT_FRAME_MAX_BYTES` = 4 MiB).
pub const DEFAULT_EVENT_FRAME_MAX_BYTES: usize = 4 * 1024 * 1024;

/// Default `SendInput` deadline (TS `DEFAULT_SEND_INPUT_TIMEOUT_MS`).
pub const DEFAULT_SEND_INPUT_TIMEOUT: Duration = Duration::from_secs(30);

/// Default `SendSignal` deadline (TS `DEFAULT_SEND_SIGNAL_TIMEOUT_MS`).
pub const DEFAULT_SEND_SIGNAL_TIMEOUT: Duration = Duration::from_secs(10);

/// Default Update deadline (TS `DEFAULT_UPDATE_TIMEOUT_MS`).
pub const DEFAULT_UPDATE_TIMEOUT: Duration = Duration::from_secs(30);

/// Unary control retry budget (TS `DEFAULT_UNARY_ATTEMPTS`).
pub const DEFAULT_UNARY_ATTEMPTS: u32 = 3;

/// Default exponential retry backoff base (TS
/// `DEFAULT_UNARY_RETRY_BASE_DELAY_MS`).
pub const DEFAULT_UNARY_RETRY_BASE_DELAY: Duration = Duration::from_millis(500);

/// Default reattach budget for a stream (TS `DEFAULT_MAX_RECONNECTS`).
pub const DEFAULT_MAX_RECONNECTS: u32 = 5;

/// Default reattach backoff base (TS `DEFAULT_RECONNECT_BASE_DELAY_MS`).
pub const DEFAULT_RECONNECT_BASE_DELAY: Duration = Duration::from_millis(500);

/// Default in-memory event backlog bound (TS
/// `DEFAULT_MAX_PENDING_EVENTS`); the stream stops reading the wire when
/// the consumer is this many events behind.
pub const DEFAULT_MAX_PENDING_EVENTS: usize = 1024;

/// sandboxd's own default keepalive cadence (TS
/// `DEFAULT_KEEPALIVE_INTERVAL_SECONDS`).
pub const DEFAULT_KEEPALIVE_INTERVAL_SECONDS: u32 = 90;

/// Cap on a unary proto response body (TS `MAX_UNARY_BODY_BYTES`).
pub const MAX_UNARY_BODY_BYTES: usize = 1024 * 1024;

/// The sandbox-bound gateway credentials the client needs, resolved per
/// operation from an injected source. Callers own caching and proactive
/// expiry refresh (TS contract).
pub trait GatewayAuthSource: Send + Sync {
    /// Current (cached) sandbox auth.
    fn get_auth(&self) -> impl Future<Output = Result<GatewayAuth, CommandSessionError>> + Send;

    /// Force-refresh on 401/unauthenticated; defaults to
    /// [`GatewayAuthSource::get_auth`].
    fn refresh_auth(
        &self,
    ) -> impl Future<Output = Result<GatewayAuth, CommandSessionError>> + Send {
        self.get_auth()
    }
}

/// Client construction options; every field except the frame bound and
/// the keepalive cadence has a safe default.
#[derive(Debug, Clone, Default)]
pub struct CommandSessionOptions {
    /// Hard cap on a single streaming frame; default 4 MiB.
    pub max_event_frame_bytes: Option<usize>,
    /// `Keepalive-Ping-Interval` seconds header on streaming RPCs;
    /// default 90.
    pub keepalive_interval_seconds: Option<u32>,
    /// Permit plain `http://` for loopback gateway URLs.
    pub allow_insecure_localhost: bool,
    /// Exponential retry backoff base for unary control RPCs; default
    /// 500 ms. Tests shrink it.
    pub unary_retry_base_delay: Option<Duration>,
}

/// Stream attach tuning, per [`CommandSessionClient::start`] or
/// [`CommandSessionClient::connect`] call.
#[derive(Debug, Clone, Default)]
pub struct StreamOptions {
    /// Reattach budget for recoverable stream faults; default 5.
    pub max_reconnects: Option<u32>,
    /// Exponential backoff base: `base * 2^(n-1)`; default 500 ms. Tests
    /// shrink it.
    pub reconnect_base_delay: Option<Duration>,
    /// In-memory event backlog bound; default 1024.
    pub max_pending_events: Option<usize>,
}

/// Start options ([`CommandSessionClient::start`]).
#[derive(Debug, Clone, Default)]
pub struct StartOptions {
    /// Stream attach tuning.
    pub stream: StreamOptions,
    /// `Connect-Timeout-Ms` on Start: sandboxd kills the process at this
    /// deadline (the attachment aborts at it too). `Some(0)` sends an
    /// explicit no-deadline; `None` inherits the server default.
    /// Reconnecting does not extend the deadline the first Start set.
    /// Unary control RPCs never set the process deadline; sandboxd reads
    /// the header as one only in Start.
    pub connect_timeout_ms: Option<u64>,
}

/// Unary control options.
#[derive(Debug, Clone, Default)]
pub struct ControlOptions {
    /// Client deadline for the control RPC.
    pub connect_timeout_ms: Option<Duration>,
}

/// `SendInput` options.
#[derive(Debug, Clone, Default)]
pub struct SendInputOptions {
    /// Unary control options.
    pub control: ControlOptions,
    /// At-most-once key for this write; generated when omitted. A retried
    /// attempt resends it byte-identically, and the server acknowledges a
    /// duplicate without writing again.
    pub input_uuid: Option<String>,
}

/// `SendSignal` options.
#[derive(Debug, Clone, Default)]
pub struct SendSignalOptions {
    /// Unary control options.
    pub control: ControlOptions,
    /// At-most-once key for this delivery; generated when omitted.
    pub signal_uuid: Option<String>,
}

/// The client for the sandboxd command-session service of one sandbox.
/// One client may hold many concurrent process streams; each stream owns
/// its own HTTP request/connection because a live session occupies it
/// for the session's lifetime (the gateway caps concurrent streams per
/// connection).
#[derive(Debug)]
pub struct CommandSessionClient<T, A>
where
    T: SandboxTransport,
    A: GatewayAuthSource,
{
    inner: Arc<ClientInner<T, A>>,
}

#[derive(Debug)]
pub(crate) struct ClientInner<T, A> {
    pub(crate) transport: T,
    pub(crate) auth: A,
    pub(crate) max_event_frame_bytes: usize,
    pub(crate) keepalive_interval_seconds: u32,
    pub(crate) allow_insecure_localhost: bool,
    pub(crate) unary_retry_base_delay: Duration,
}

impl<A: GatewayAuthSource + 'static>
    CommandSessionClient<crate::transport::ReqwestSandboxTransport, A>
{
    /// The production client with the reqwest transport.
    ///
    /// # Errors
    ///
    /// Returns [`CommandSessionErrorCode::InvalidRequest`] when an
    /// option fails validation (zero frame bound or keepalive cadence).
    pub fn new(auth: A, options: CommandSessionOptions) -> Result<Self, CommandSessionError> {
        Self::with_transport(
            crate::transport::ReqwestSandboxTransport::new(),
            auth,
            options,
        )
    }
}

impl<T, A> CommandSessionClient<T, A>
where
    T: SandboxTransport + 'static,
    A: GatewayAuthSource + 'static,
{
    /// A client over an injected transport.
    ///
    /// # Errors
    ///
    /// Returns [`CommandSessionErrorCode::InvalidRequest`] when an option
    /// fails validation (zero frame bound or keepalive cadence).
    /// The options mirror the TS constructor's single options object;
    /// taking it by value keeps the call one-line for callers.
    #[allow(clippy::needless_pass_by_value)]
    pub fn with_transport(
        transport: T,
        auth: A,
        options: CommandSessionOptions,
    ) -> Result<Self, CommandSessionError> {
        let max_event_frame_bytes = options
            .max_event_frame_bytes
            .unwrap_or(DEFAULT_EVENT_FRAME_MAX_BYTES);
        if max_event_frame_bytes == 0 {
            return Err(CommandSessionError::invalid_request(
                "maxEventFrameBytes must be a positive integer",
            ));
        }
        let keepalive_interval_seconds = options
            .keepalive_interval_seconds
            .unwrap_or(DEFAULT_KEEPALIVE_INTERVAL_SECONDS);
        if keepalive_interval_seconds == 0 {
            return Err(CommandSessionError::invalid_request(
                "keepaliveIntervalSeconds must be a positive integer",
            ));
        }
        Ok(Self {
            inner: Arc::new(ClientInner {
                transport,
                auth,
                max_event_frame_bytes,
                keepalive_interval_seconds,
                allow_insecure_localhost: options.allow_insecure_localhost,
                unary_retry_base_delay: options
                    .unary_retry_base_delay
                    .unwrap_or(DEFAULT_UNARY_RETRY_BASE_DELAY),
            }),
        })
    }

    /// Start (or attach to) a process. Resolves once the start event
    /// confirms the session, making it the resident-launch primitive:
    /// call [`CommandSessionStream::release`] right after to leave the
    /// process running. A Start whose stream faults before its start
    /// event is re-issued with identical bytes (create-or-attach); after
    /// it, reattach uses Connect with the session selector.
    ///
    /// # Errors
    ///
    /// Returns [`CommandSessionErrorCode::InvalidRequest`] for an invalid
    /// request or options; the typed fault when the first start event
    /// never arrives (reconnect budget exhausted, stream released, or a
    /// definitive protocol answer).
    pub async fn start(
        &self,
        request: &StartRequest,
        options: StartOptions,
    ) -> Result<CommandSessionStream, CommandSessionError> {
        let start_bytes = self.encode_request("Start", || encode_start_request(request))?;
        let connect_bytes =
            self.encode_request("Connect", || encode_connect_request(&request.session_uuid))?;
        let stream = self
            .open_stream(
                start_bytes,
                connect_bytes,
                false,
                &options.stream,
                options.connect_timeout_ms,
            )
            .await?;
        Ok(stream)
    }

    /// Attach to a session by its UUID without starting anything. Replays
    /// the retained start+end events of a session that exited within the
    /// retention window. Reattach on recoverable faults re-Connects.
    ///
    /// # Errors
    ///
    /// Returns [`CommandSessionErrorCode::InvalidRequest`] for an invalid
    /// UUID or options; the typed fault when the replayed start event
    /// never arrives.
    pub async fn connect(
        &self,
        session_uuid: &str,
        options: StreamOptions,
    ) -> Result<CommandSessionStream, CommandSessionError> {
        let connect_bytes =
            self.encode_request("Connect", || encode_connect_request(session_uuid))?;
        let stream = self
            .open_stream(connect_bytes.clone(), connect_bytes, true, &options, None)
            .await?;
        Ok(stream)
    }

    /// Write bytes to the process's stdin (or its PTY). Retries transient
    /// faults with the same input UUID, so a duplicate application is
    /// acknowledged by the server without writing again.
    ///
    /// # Errors
    ///
    /// Returns [`CommandSessionErrorCode::InvalidRequest`] for empty input
    /// or a non-UUID key, [`CommandSessionErrorCode::TooLarge`] over
    /// [`MAX_PROCESS_INPUT_BYTES`], and the typed fault otherwise.
    pub async fn send_input(
        &self,
        session_uuid: &str,
        channel: InputChannel,
        data: &[u8],
        options: SendInputOptions,
    ) -> Result<(), CommandSessionError> {
        if data.is_empty() {
            return Err(CommandSessionError::invalid_request(
                "sendInput data must not be empty",
            ));
        }
        if data.len() > MAX_PROCESS_INPUT_BYTES {
            return Err(CommandSessionError::too_large(format!(
                "sendInput data exceeds the {MAX_PROCESS_INPUT_BYTES} byte limit"
            )));
        }
        let input_uuid = options
            .input_uuid
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let request_bytes = self.encode_request("SendInput", || {
            encode_send_input_request(session_uuid, channel, data, &input_uuid)
        })?;
        let timeout = options
            .control
            .connect_timeout_ms
            .unwrap_or(DEFAULT_SEND_INPUT_TIMEOUT);
        self.unary_with_retry("SendInput", request_bytes, timeout)
            .await
    }

    /// Deliver SIGTERM (`terminate`) or SIGKILL (`kill`) to the session.
    ///
    /// # Errors
    ///
    /// Returns the typed fault when the delivery fails after its retry
    /// budget.
    pub async fn send_signal(
        &self,
        session_uuid: &str,
        signal: VmSignal,
        options: SendSignalOptions,
    ) -> Result<(), CommandSessionError> {
        let signal_uuid = options
            .signal_uuid
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let request_bytes = self.encode_request("SendSignal", || {
            encode_send_signal_request(session_uuid, signal, &signal_uuid)
        })?;
        let timeout = options
            .control
            .connect_timeout_ms
            .unwrap_or(DEFAULT_SEND_SIGNAL_TIMEOUT);
        self.unary_with_retry("SendSignal", request_bytes, timeout)
            .await
    }

    /// Resize the session's PTY (`Update`).
    ///
    /// # Errors
    ///
    /// Returns the typed fault when the update fails after its retry
    /// budget.
    pub async fn resize(
        &self,
        session_uuid: &str,
        size: PtySize,
        options: ControlOptions,
    ) -> Result<(), CommandSessionError> {
        let request_bytes =
            self.encode_request("Update", || encode_update_request(session_uuid, size))?;
        let timeout = options.connect_timeout_ms.unwrap_or(DEFAULT_UPDATE_TIMEOUT);
        self.unary_with_retry("Update", request_bytes, timeout)
            .await
    }

    // --- internals ---

    fn encode_request(
        &self,
        method: &'static str,
        encode: impl FnOnce() -> Result<Vec<u8>, ProtoError>,
    ) -> Result<Vec<u8>, CommandSessionError> {
        let _ = self;
        encode_request(method, encode)
    }
}

/// Encode one RPC request, mapping codec failures onto the typed client
/// error (TS `encodeRequest`).
fn encode_request(
    method: &'static str,
    encode: impl FnOnce() -> Result<Vec<u8>, ProtoError>,
) -> Result<Vec<u8>, CommandSessionError> {
    encode().map_err(|error| match error.kind() {
        ProtoErrorKind::OversizeFrame => CommandSessionError::too_large(error.to_string()),
        ProtoErrorKind::InvalidInput => CommandSessionError::invalid_request(format!(
            "{method} request encoding failed: {error}"
        )),
        ProtoErrorKind::InvalidWire => CommandSessionError::invalid_response(format!(
            "{method} request encoding failed: {error}"
        )),
    })
}

impl<T, A> CommandSessionClient<T, A>
where
    T: SandboxTransport + 'static,
    A: GatewayAuthSource + 'static,
{
    /// Spawn the pump and await its first start event.
    async fn open_stream(
        &self,
        start_bytes: Vec<u8>,
        connect_bytes: Vec<u8>,
        initial_route_connect: bool,
        options: &StreamOptions,
        connect_timeout_ms: Option<u64>,
    ) -> Result<CommandSessionStream, CommandSessionError> {
        let max_reconnects = options.max_reconnects.unwrap_or(DEFAULT_MAX_RECONNECTS);
        let reconnect_base_delay = options
            .reconnect_base_delay
            .unwrap_or(DEFAULT_RECONNECT_BASE_DELAY);
        let max_pending_events = options
            .max_pending_events
            .unwrap_or(DEFAULT_MAX_PENDING_EVENTS);
        if max_pending_events == 0 {
            return Err(CommandSessionError::invalid_request(
                "maxPendingEvents must be a positive integer",
            ));
        }
        let stream = spawn_stream(
            Arc::clone(&self.inner),
            PumpConfig {
                start_bytes,
                connect_bytes,
                initial_route_connect,
                max_reconnects,
                reconnect_base_delay,
                connect_timeout_ms,
            },
            max_pending_events,
        );
        // Resolve the start event before handing the stream out (TS
        // `await stream.started`).
        await_started(stream).await
    }

    async fn unary_with_retry(
        &self,
        method: &'static str,
        request_bytes: Vec<u8>,
        timeout: Duration,
    ) -> Result<(), CommandSessionError> {
        // TS parity: an explicitly supplied control-RPC deadline must be
        // positive (the streaming Start has its own zero-disables
        // semantics).
        if timeout.is_zero() {
            return Err(CommandSessionError::invalid_request(
                "connectTimeoutMs must be a positive duration",
            ));
        }
        let mut attempt = 0;
        loop {
            attempt += 1;
            let outcome = self.unary(method, &request_bytes, timeout).await;
            match outcome {
                Ok(()) => return Ok(()),
                Err(error) => {
                    if attempt >= DEFAULT_UNARY_ATTEMPTS || !error.is_transient_control_fault() {
                        return Err(error);
                    }
                    let backoff = self
                        .inner
                        .unary_retry_base_delay
                        .saturating_mul(1 << (attempt - 1).min(30));
                    tokio::time::sleep(backoff).await;
                }
            }
        }
    }

    /// One unary control RPC: open (auth-refreshing), strict media-type
    /// check, bounded body read, empty-message validation.
    async fn unary(
        &self,
        method: &'static str,
        request_bytes: &[u8],
        timeout: Duration,
    ) -> Result<(), CommandSessionError> {
        with_auth_retry_on(&self.inner, method, |auth| {
            let inner = &self.inner;
            async move {
                let url = rpc_url(inner, &auth, method)?;
                let request = TransportRequest {
                    method: Method::Post,
                    headers: unary_headers(&auth, timeout),
                    url: url.clone(),
                    body: Some(request_bytes.to_vec()),
                    max_response_bytes: None,
                    timeout: Some(timeout),
                };
                let mut response =
                    inner
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
                    let text = read_error_preview(&mut response.body).await;
                    return Err(error_from_status_body(
                        response.status,
                        &text,
                        method,
                        &url,
                        &auth,
                    ));
                }
                if !is_media_type(response.header("content-type"), "application/proto") {
                    return Err(CommandSessionError::invalid_response(format!(
                        "Command session {method} must respond application/proto"
                    ))
                    .with_context(
                        method,
                        url.clone(),
                        Some(response.status),
                        None,
                    ));
                }
                let mut body = Vec::new();
                while let Some(chunk) = response.body.next_chunk().await.map_err(|error| {
                    CommandSessionError::from_sandbox_error(&error).with_context(
                        method,
                        url.clone(),
                        None,
                        None,
                    )
                })? {
                    if body.len() + chunk.len() > MAX_UNARY_BODY_BYTES {
                        return Err(CommandSessionError::too_large(format!(
                            "Command session {method} response exceeds the unary body limit"
                        ))
                        .with_context(
                            method,
                            url.clone(),
                            Some(response.status),
                            None,
                        ));
                    }
                    body.extend_from_slice(&chunk);
                }
                if !body.is_empty() {
                    decode_empty_message(&body).map_err(|error| {
                        CommandSessionError::invalid_response(error.to_string()).with_context(
                            method,
                            url.clone(),
                            Some(response.status),
                            None,
                        )
                    })?;
                }
                Ok(())
            }
        })
        .await
    }
}

/// Resolve auth, run `op`, and retry exactly once with a refreshed auth
/// when the operation fails `unauthenticated` (TS `withAuthRetry`).
pub(crate) async fn with_auth_retry_on<T, A, R, Fut>(
    inner: &ClientInner<T, A>,
    method: &'static str,
    op: impl Fn(GatewayAuth) -> Fut,
) -> Result<R, CommandSessionError>
where
    T: SandboxTransport,
    A: GatewayAuthSource,
    Fut: Future<Output = Result<R, CommandSessionError>> + Send,
{
    let mut refreshed = false;
    loop {
        let auth = if refreshed {
            inner.auth.refresh_auth().await
        } else {
            inner.auth.get_auth().await
        };
        let auth = match auth {
            Ok(auth) if !auth.token.is_empty() => auth,
            Ok(_) => {
                return Err(CommandSessionError::invalid_response(if refreshed {
                    "refreshAuth returned no usable gateway auth"
                } else {
                    "getAuth returned no usable gateway auth"
                })
                .with_context(method, "", None, None));
            }
            Err(error) => return Err(error),
        };
        match op(auth).await {
            Ok(value) => return Ok(value),
            Err(error) => {
                if !refreshed && error.code() == CommandSessionErrorCode::Unauthenticated {
                    refreshed = true;
                    continue;
                }
                return Err(error);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

// The platform-backed auth source
// ---------------------------------------------------------------------------

/// An uncached [`GatewayAuthSource`] over the platform auth endpoint:
/// every resolution (including refresh) fetches fresh sandbox-bound
/// gateway credentials. Callers that want caching wrap this and own the
/// expiry bookkeeping (TS contract: caching stays with the caller).
pub struct PlatformGatewayAuthSource<T: SandboxTransport> {
    client: Arc<crate::client::PrimeSandboxClient<T>>,
    sandbox_id: String,
    request_timeout: Option<Duration>,
}

impl<T: SandboxTransport> PlatformGatewayAuthSource<T> {
    /// Build the source for one sandbox's credentials.
    ///
    /// # Errors
    ///
    /// Returns [`crate::SandboxErrorCode::InvalidRequest`] for a
    /// malformed sandbox id.
    pub fn new(
        client: Arc<crate::client::PrimeSandboxClient<T>>,
        sandbox_id: impl Into<String>,
    ) -> Result<Self, crate::SandboxError> {
        let sandbox_id = sandbox_id.into();
        crate::wire::assert_sandbox_id(&sandbox_id)?;
        Ok(Self {
            client,
            sandbox_id,
            request_timeout: None,
        })
    }

    /// Per-auth-fetch deadline override.
    #[must_use]
    pub fn with_request_timeout(mut self, timeout: Option<Duration>) -> Self {
        self.request_timeout = timeout;
        self
    }
}

impl<T: SandboxTransport> GatewayAuthSource for PlatformGatewayAuthSource<T> {
    async fn get_auth(&self) -> Result<GatewayAuth, CommandSessionError> {
        let options = GatewayOptions {
            auth: None,
            request_timeout: self.request_timeout,
        };
        self.client
            .get_sandbox_auth(&self.sandbox_id, &options)
            .await
            .map_err(|error| CommandSessionError::from_sandbox_error(&error))
    }
}
