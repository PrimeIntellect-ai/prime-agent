//! Typed, redacted errors for the sandbox `command_session` client.
//! Port of the `VmProcessError` half of `vm-process-client.ts` (TS branch
//! `feat/direct-cloud-sandbox`): client-side failure codes plus the
//! Connect codes this surface can surface, with no secret (gateway token)
//! ever appearing in a message, URL, or `details` preview.

use thiserror::Error;

/// The client failure codes plus the Connect codes this surface can
/// surface; wire names identical to the TS `VmProcessErrorCode` set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum CommandSessionErrorCode {
    /// Bad caller input; nothing was sent.
    #[error("invalid_request")]
    InvalidRequest,
    /// Transport-level fault before/at HTTP.
    #[error("network")]
    Network,
    /// Client-side deadline elapsed.
    #[error("timeout")]
    Timeout,
    /// Peer response violated the wire contract.
    #[error("invalid_response")]
    InvalidResponse,
    /// Peer data exceeded a bound.
    #[error("too_large")]
    TooLarge,
    /// The stream was released locally before the process ended.
    #[error("released")]
    Released,
    /// The stream operation was canceled.
    #[error("canceled")]
    Canceled,
    /// An unknown Connect-level failure.
    #[error("unknown")]
    Unknown,
    /// Connect `invalid_argument`.
    #[error("invalid_argument")]
    InvalidArgument,
    /// Connect `deadline_exceeded`.
    #[error("deadline_exceeded")]
    DeadlineExceeded,
    /// Connect `not_found`.
    #[error("not_found")]
    NotFound,
    /// Connect `already_exists`.
    #[error("already_exists")]
    AlreadyExists,
    /// Connect `permission_denied`.
    #[error("permission_denied")]
    PermissionDenied,
    /// Connect `resource_exhausted`.
    #[error("resource_exhausted")]
    ResourceExhausted,
    /// Connect `failed_precondition`.
    #[error("failed_precondition")]
    FailedPrecondition,
    /// Connect `aborted`.
    #[error("aborted")]
    Aborted,
    /// Connect `out_of_range`.
    #[error("out_of_range")]
    OutOfRange,
    /// Connect `unimplemented`.
    #[error("unimplemented")]
    Unimplemented,
    /// Connect `internal`.
    #[error("internal")]
    Internal,
    /// Connect `unavailable`.
    #[error("unavailable")]
    Unavailable,
    /// Connect `data_loss`.
    #[error("data_loss")]
    DataLoss,
    /// Connect `unauthenticated`.
    #[error("unauthenticated")]
    Unauthenticated,
    /// Gateway 502 with `{ "error": "sandbox_not_found" }`: the sandbox
    /// is gone.
    #[error("sandbox_not_found")]
    SandboxNotFound,
}

impl CommandSessionErrorCode {
    /// The wire name; Connect JSON codes parse by it.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::Network => "network",
            Self::Timeout => "timeout",
            Self::InvalidResponse => "invalid_response",
            Self::TooLarge => "too_large",
            Self::Released => "released",
            Self::Canceled => "canceled",
            Self::Unknown => "unknown",
            Self::InvalidArgument => "invalid_argument",
            Self::DeadlineExceeded => "deadline_exceeded",
            Self::NotFound => "not_found",
            Self::AlreadyExists => "already_exists",
            Self::PermissionDenied => "permission_denied",
            Self::ResourceExhausted => "resource_exhausted",
            Self::FailedPrecondition => "failed_precondition",
            Self::Aborted => "aborted",
            Self::OutOfRange => "out_of_range",
            Self::Unimplemented => "unimplemented",
            Self::Internal => "internal",
            Self::Unavailable => "unavailable",
            Self::DataLoss => "data_loss",
            Self::Unauthenticated => "unauthenticated",
            Self::SandboxNotFound => "sandbox_not_found",
        }
    }

    /// Parse a Connect JSON error code.
    #[must_use]
    pub fn from_connect(value: &str) -> Option<Self> {
        Some(match value {
            "canceled" => Self::Canceled,
            "unknown" => Self::Unknown,
            "invalid_argument" => Self::InvalidArgument,
            "deadline_exceeded" => Self::DeadlineExceeded,
            "not_found" => Self::NotFound,
            "already_exists" => Self::AlreadyExists,
            "permission_denied" => Self::PermissionDenied,
            "resource_exhausted" => Self::ResourceExhausted,
            "failed_precondition" => Self::FailedPrecondition,
            "aborted" => Self::Aborted,
            "out_of_range" => Self::OutOfRange,
            "unimplemented" => Self::Unimplemented,
            "internal" => Self::Internal,
            "unavailable" => Self::Unavailable,
            "data_loss" => Self::DataLoss,
            "unauthenticated" => Self::Unauthenticated,
            _ => return None,
        })
    }

    /// Map an HTTP status onto a Connect code when no JSON code is
    /// available (TS `codeFromStatus`).
    #[must_use]
    pub fn from_status(status: u16) -> Self {
        match status {
            400 => Self::InvalidArgument,
            401 => Self::Unauthenticated,
            403 => Self::PermissionDenied,
            404 | 501 => Self::Unimplemented,
            408 | 504 => Self::DeadlineExceeded,
            429 | 502 | 503 => Self::Unavailable,
            500 => Self::Internal,
            _ => Self::Unknown,
        }
    }
}

/// A typed, redacted `command_session` client failure. `details` carries a
/// bounded, secret-scrubbed response preview; messages never contain the
/// gateway token.
#[derive(Debug, Error)]
#[error("{message}")]
pub struct CommandSessionError {
    code: CommandSessionErrorCode,
    message: String,
    method: Option<&'static str>,
    url: Option<String>,
    status: Option<u16>,
    details: Option<String>,
}

impl CommandSessionError {
    /// Build an error with just a message.
    #[must_use]
    pub fn new(code: CommandSessionErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            method: None,
            url: None,
            status: None,
            details: None,
        }
    }

    /// A local validation failure; nothing was sent.
    #[must_use]
    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(CommandSessionErrorCode::InvalidRequest, message)
    }

    /// A strict-response-parsing failure.
    #[must_use]
    pub fn invalid_response(message: impl Into<String>) -> Self {
        Self::new(CommandSessionErrorCode::InvalidResponse, message)
    }

    /// A connection-level failure.
    #[must_use]
    pub fn network(message: impl Into<String>) -> Self {
        Self::new(CommandSessionErrorCode::Network, message)
    }

    /// A deadline failure.
    #[must_use]
    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(CommandSessionErrorCode::Timeout, message)
    }

    /// A body over a bound.
    #[must_use]
    pub fn too_large(message: impl Into<String>) -> Self {
        Self::new(CommandSessionErrorCode::TooLarge, message)
    }

    /// The stream was released before the process ended.
    #[must_use]
    pub fn released(message: impl Into<String>) -> Self {
        Self::new(CommandSessionErrorCode::Released, message)
    }

    /// A sandbox that is no longer present on the runtime node (gateway
    /// 502 with `{ "error": "sandbox_not_found" }`).
    #[must_use]
    pub fn sandbox_not_found(message: impl Into<String>) -> Self {
        Self::new(CommandSessionErrorCode::SandboxNotFound, message)
    }

    /// The typed code.
    #[must_use]
    pub fn code(&self) -> CommandSessionErrorCode {
        self.code
    }

    /// The RPC method name, when the failure carries it.
    #[must_use]
    pub fn method(&self) -> Option<&'static str> {
        self.method
    }

    /// The sanitized request URL (never carries credentials).
    #[must_use]
    pub fn url(&self) -> Option<&str> {
        self.url.as_deref()
    }

    /// The HTTP status for status-mapped codes.
    #[must_use]
    pub fn status(&self) -> Option<u16> {
        self.status
    }

    /// The bounded, secret-scrubbed response preview.
    #[must_use]
    pub fn details(&self) -> Option<&str> {
        self.details.as_deref()
    }

    /// Attach the request context (method, url, status, details) to a
    /// status or response error, mirroring the TS error properties.
    #[must_use]
    pub fn with_context(
        mut self,
        method: &'static str,
        url: impl Into<String>,
        status: Option<u16>,
        details: Option<String>,
    ) -> Self {
        self.method = Some(method);
        self.url = Some(url.into());
        self.status = status;
        if details.is_some() {
            self.details = details;
        }
        self
    }

    /// Recoverable-for-reattach faults: link-level trouble and retryable
    /// server codes, not definitive protocol answers (TS
    /// `isRecoverableStreamFault`). The stricter allow-list means
    /// permanent answers (`invalid_argument`,
    /// `unauthenticated`-after-refresh, `permission_denied`,
    /// `sandbox_not_found`) do not burn the reconnect budget retrying a
    /// request that cannot succeed.
    #[must_use]
    pub fn is_recoverable_stream_fault(&self) -> bool {
        matches!(
            self.code,
            CommandSessionErrorCode::Network
                | CommandSessionErrorCode::Timeout
                | CommandSessionErrorCode::Unavailable
                | CommandSessionErrorCode::DeadlineExceeded
                | CommandSessionErrorCode::Canceled
                | CommandSessionErrorCode::Unknown
                | CommandSessionErrorCode::Internal
        )
    }

    /// Transient unary control faults worth retrying (TS
    /// `isTransientControlFault`).
    #[must_use]
    pub fn is_transient_control_fault(&self) -> bool {
        matches!(
            self.code,
            CommandSessionErrorCode::Network
                | CommandSessionErrorCode::Timeout
                | CommandSessionErrorCode::Unavailable
                | CommandSessionErrorCode::DeadlineExceeded
        )
    }

    /// Build from a [`crate::SandboxError`] delivered by the transport or
    /// an auth source (TS `toVmProcessError`: transport-level failures keep
    /// their class; any other failure is a network fault).
    #[must_use]
    pub fn from_sandbox_error(error: &crate::SandboxError) -> Self {
        match error.code() {
            crate::SandboxErrorCode::Timeout => Self::timeout(error.to_string()),
            crate::SandboxErrorCode::TooLarge => Self::too_large(error.to_string()),
            _ => Self::network(error.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_codes_round_trip_the_ts_wire_names() {
        for (code, wire) in [
            (CommandSessionErrorCode::Canceled, "canceled"),
            (CommandSessionErrorCode::Unknown, "unknown"),
            (CommandSessionErrorCode::InvalidArgument, "invalid_argument"),
            (
                CommandSessionErrorCode::DeadlineExceeded,
                "deadline_exceeded",
            ),
            (CommandSessionErrorCode::NotFound, "not_found"),
            (CommandSessionErrorCode::AlreadyExists, "already_exists"),
            (
                CommandSessionErrorCode::PermissionDenied,
                "permission_denied",
            ),
            (
                CommandSessionErrorCode::ResourceExhausted,
                "resource_exhausted",
            ),
            (
                CommandSessionErrorCode::FailedPrecondition,
                "failed_precondition",
            ),
            (CommandSessionErrorCode::Aborted, "aborted"),
            (CommandSessionErrorCode::OutOfRange, "out_of_range"),
            (CommandSessionErrorCode::Unimplemented, "unimplemented"),
            (CommandSessionErrorCode::Internal, "internal"),
            (CommandSessionErrorCode::Unavailable, "unavailable"),
            (CommandSessionErrorCode::DataLoss, "data_loss"),
            (CommandSessionErrorCode::Unauthenticated, "unauthenticated"),
        ] {
            assert_eq!(code.as_str(), wire);
            assert_eq!(CommandSessionErrorCode::from_connect(wire), Some(code));
        }
        assert_eq!(
            CommandSessionErrorCode::from_connect("invalid_request"),
            None
        );
        assert_eq!(CommandSessionErrorCode::from_connect("nope"), None);
    }

    #[test]
    fn statuses_map_onto_connect_codes() {
        for (status, code) in [
            (400, CommandSessionErrorCode::InvalidArgument),
            (401, CommandSessionErrorCode::Unauthenticated),
            (403, CommandSessionErrorCode::PermissionDenied),
            (404, CommandSessionErrorCode::Unimplemented),
            (408, CommandSessionErrorCode::DeadlineExceeded),
            (429, CommandSessionErrorCode::Unavailable),
            (500, CommandSessionErrorCode::Internal),
            (501, CommandSessionErrorCode::Unimplemented),
            (502, CommandSessionErrorCode::Unavailable),
            (503, CommandSessionErrorCode::Unavailable),
            (504, CommandSessionErrorCode::DeadlineExceeded),
            (418, CommandSessionErrorCode::Unknown),
        ] {
            assert_eq!(CommandSessionErrorCode::from_status(status), code);
        }
    }

    #[test]
    fn fault_classification_follows_the_ts_allow_lists() {
        for code in [
            CommandSessionErrorCode::Network,
            CommandSessionErrorCode::Timeout,
            CommandSessionErrorCode::Unavailable,
            CommandSessionErrorCode::DeadlineExceeded,
        ] {
            let error = CommandSessionError::new(code, "x");
            assert!(error.is_recoverable_stream_fault(), "{code:?}");
            assert!(error.is_transient_control_fault(), "{code:?}");
        }
        // Recoverable for reattach but NOT transient for unary retries
        // (the TS lists differ).
        for code in [
            CommandSessionErrorCode::Canceled,
            CommandSessionErrorCode::Unknown,
            CommandSessionErrorCode::Internal,
        ] {
            let error = CommandSessionError::new(code, "x");
            assert!(error.is_recoverable_stream_fault(), "{code:?}");
            assert!(
                !error.is_transient_control_fault(),
                "{code:?} must not be transient"
            );
        }
        for code in [
            CommandSessionErrorCode::InvalidArgument,
            CommandSessionErrorCode::NotFound,
            CommandSessionErrorCode::FailedPrecondition,
            CommandSessionErrorCode::PermissionDenied,
            CommandSessionErrorCode::SandboxNotFound,
            CommandSessionErrorCode::InvalidRequest,
            CommandSessionErrorCode::InvalidResponse,
            CommandSessionErrorCode::Released,
        ] {
            let error = CommandSessionError::new(code, "x");
            assert!(
                !error.is_recoverable_stream_fault(),
                "{code:?} must not be recoverable"
            );
            assert!(
                !error.is_transient_control_fault(),
                "{code:?} must not be transient"
            );
        }
        // sandbox_not_found is not recoverable but the error carries its
        // dedicated code.
        assert_eq!(
            CommandSessionError::sandbox_not_found("gone").code(),
            CommandSessionErrorCode::SandboxNotFound
        );
    }
}
