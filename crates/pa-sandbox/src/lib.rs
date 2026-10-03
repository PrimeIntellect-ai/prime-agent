//! Prime Sandboxes lifecycle client for Prime Agent cloud delegation.
//!
//! Port of the lifecycle half of `prime-sandbox-client.ts` (TS branch
//! `feat/direct-cloud-sandbox`, the ground-truth direct REST client for
//! Prime Sandboxes), cross-checked against the live `prime_sandboxes` SDK
//! (`~/pi/prime/packages/prime-sandboxes`) and the platform backend wire
//! contract:
//!
//! - create (`POST /api/v1/sandbox`): `snake_case` body, `vm: true` forced,
//!   a fresh UUID `idempotency_key` when unset, retries of transient
//!   transport failures that reuse the same server-side key;
//! - fetch (`GET /api/v1/sandbox/{id}`): `camelCase` body
//!   (`memoryGB`, `diskSizeGB`, ...) with `snake_case` egress lists;
//! - delete (`DELETE /api/v1/sandbox/{id}`): idempotent, a 404 is success;
//! - wait: poll fetch until `RUNNING`, fail fast on a terminal status,
//!   fail with `timeout` when the budget is exhausted.
//!
//! Safety contract (TS parity): no secret ever appears in an error
//! message, URL, or `details` preview; every response is strictly
//! validated (a 200 with a malformed body is a typed `invalid_response`
//! error, never a silent default); all URL segments derived from platform
//! data are validated before use; everything is injected (API key, base
//! URL, transport, team id, deadlines) so nothing is read from the
//! environment or `~/.prime`.
//!
//! Out of scope for this slice (see the TS module header for the full
//! contract): the per-sandbox gateway (auth, exec, upload, download) and
//! the `ConnectRPC` `command_session` stream VM execution uses.

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
    Sandbox, SandboxStatus, StartCommand, VmCreateRequest, WaitOptions, DEFAULT_REQUEST_TIMEOUT,
    DEFAULT_WAIT_POLL_INTERVAL, DEFAULT_WAIT_TIMEOUT, PRIME_SANDBOX_CREATE_MAX_ATTEMPTS,
};
