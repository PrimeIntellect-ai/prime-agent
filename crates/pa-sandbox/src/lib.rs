//! Prime Sandboxes lifecycle client.
//!
//! [`PrimeSandboxClient`] calls the Prime platform REST API: idempotent VM
//! create, fetch, list by label, pause, resume, delete, wait-until-running,
//! and filesystem checkpoints.
//!
//! [`CommandSessionClient`] runs processes in a VM sandbox through the
//! sandbox gateway's `ConnectRPC` `command_session` stream (Start, Connect,
//! `SendInput`, `SendSignal`), and [`PrimeSandboxClient::upload_file`] writes
//! one file through the gateway's multipart transfer endpoint. [`PlatformGatewayAuthSource`] fetches the
//! sandbox-bound gateway credentials it needs, and [`secrets`] lists and
//! creates the platform secrets that header rules reference.
//!
//! Safety contract: no secret (API key) appears in an error message, URL,
//! or `details` preview; every response is strictly validated; URL segments
//! are validated before use; and the transport refuses redirects, so an
//! authenticated call never hops origins. Everything is injected (API key,
//! base URL, transport, deadlines); nothing is read from the environment.

pub mod client;
pub mod command_session;
pub mod error;
pub mod gateway;
pub mod proto;
pub mod secrets;
pub mod transport;
pub mod types;
pub mod vm_error;
pub mod vm_process;
pub mod vm_stream;

mod record;
mod vm_wire;
mod wire;

pub use client::{ClientOptions, PrimeSandboxClient, DEFAULT_BASE_URL};
pub use command_session::{
    CommandSessionEvent, CommandSpec, EndEvent, InputChannel, OutputChannel, PtySize, StartRequest,
    VmSignal,
};
pub use error::{SandboxError, SandboxErrorCode, MAX_RESPONSE_PREVIEW_CHARS};
pub use gateway::{
    GatewayAuth, GatewayOptions, UploadRequest, UploadResult, MAX_ERROR_BODY_BYTES,
    MAX_TRANSFER_BYTES,
};
pub use secrets::PlatformSecret;
pub use transport::{
    ReqwestSandboxTransport, SandboxTransport, TransportRequest, TransportResponse,
    MAX_JSON_BODY_BYTES,
};
pub use types::{
    HeaderRule, PausedSandbox, Sandbox, SandboxCheckpoint, SandboxCheckpointState, SandboxStatus,
    StartCommand, VmCreateRequest, WaitOptions, DEFAULT_REQUEST_TIMEOUT,
    DEFAULT_WAIT_POLL_INTERVAL, DEFAULT_WAIT_TIMEOUT, NO_TIMEOUT_MINUTES,
    PRIME_SANDBOX_CREATE_MAX_ATTEMPTS,
};
pub use vm_error::{CommandSessionError, CommandSessionErrorCode};
pub use vm_process::{
    CommandSessionClient, CommandSessionOptions, ControlOptions, GatewayAuthSource,
    PlatformGatewayAuthSource, SendInputOptions, SendSignalOptions, StartOptions, StreamOptions,
    DEFAULT_EVENT_FRAME_MAX_BYTES, DEFAULT_KEEPALIVE_INTERVAL_SECONDS, DEFAULT_MAX_PENDING_EVENTS,
    DEFAULT_MAX_RECONNECTS, DEFAULT_RECONNECT_BASE_DELAY, DEFAULT_SEND_INPUT_TIMEOUT,
    DEFAULT_SEND_SIGNAL_TIMEOUT, DEFAULT_UNARY_ATTEMPTS, DEFAULT_UNARY_RETRY_BASE_DELAY,
    MAX_PROCESS_INPUT_BYTES, MAX_UNARY_BODY_BYTES,
};
pub use vm_stream::CommandSessionStream;
