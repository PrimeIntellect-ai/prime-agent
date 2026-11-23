//! Prime Sandboxes lifecycle client.
//!
//! [`PrimeSandboxClient`] calls the Prime platform REST API: idempotent VM
//! create, fetch, list by label, pause, resume, delete, wait-until-running,
//! and filesystem checkpoints.
//!
//! Safety contract: no secret (API key) appears in an error message, URL,
//! or `details` preview; every response is strictly validated; URL segments
//! are validated before use; and the transport refuses redirects, so an
//! authenticated call never hops origins. Everything is injected (API key,
//! base URL, transport, deadlines); nothing is read from the environment.

pub mod client;
pub mod error;
pub mod transport;
pub mod types;

mod record;
mod wire;

pub use client::{ClientOptions, PrimeSandboxClient, DEFAULT_BASE_URL};
pub use error::{SandboxError, SandboxErrorCode, MAX_RESPONSE_PREVIEW_CHARS};
pub use transport::{
    ReqwestSandboxTransport, SandboxTransport, TransportRequest, TransportResponse,
    MAX_JSON_BODY_BYTES,
};
pub use types::{
    unix_now_secs, HeaderRule, PausedSandbox, Sandbox, SandboxCheckpoint, SandboxCheckpointState,
    SandboxStatus, StartCommand, VmCreateRequest, WaitOptions, DEFAULT_REQUEST_TIMEOUT,
    DEFAULT_WAIT_POLL_INTERVAL, DEFAULT_WAIT_TIMEOUT, NO_TIMEOUT_MINUTES,
    PRIME_SANDBOX_CREATE_MAX_ATTEMPTS,
};
