use anyhow::Result;
use pa_types::daemon::{DaemonCommand, DaemonErrorInfo, DaemonResponse};
use serde_json::Value;
/// Why a direct request failed: `NotSent` never reached the worker (safe to
/// fall back to the supervisor), `Wait` did and must not be retried.
pub(super) enum DirectRequestError {
    NotSent,
    Wait(anyhow::Error),
}

/// The daemon answered with `success: false` for one request: the daemon
/// is alive and healthy — it refused THIS request ("Prompt cannot be
/// empty", a queue/admission refusal, an unknown session selector, a
/// model the allowlist refuses, ...). Rejections carry data about the
/// request, never about the connection: the interactive loop renders
/// them inline and keeps running, while transport failures (dead
/// socket, timeout, closed connection) stay fatal.
#[derive(Debug, PartialEq)]
pub struct RequestRejected {
    /// Wire `type` of the refused command, for the rendered message.
    pub command: String,
    /// The daemon's raw error string.
    pub message: String,
    /// The typed refusal info (`errorInfo`), when the daemon typed it:
    /// `update_restarting` (the update-prepare fence, TS #2391),
    /// `session_already_active`, `model_provider_unauthenticated`, ...
    /// `None` for untyped refusals and older daemons.
    pub error_info: Option<DaemonErrorInfo>,
}

impl std::fmt::Display for RequestRejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "the daemon rejected the {} request: {}",
            self.command, self.message
        )
    }
}

impl std::error::Error for RequestRejected {}

/// Whether the error is (or wraps) a daemon refusal, not a transport
/// failure: the daemon answered and refused the request itself.
#[must_use]
pub fn is_daemon_rejection(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.downcast_ref::<RequestRejected>().is_some())
}

/// True when an open failure is the update-restart transient state (TS
/// `isDaemonUpdateRestartingError`): a typed `update_restarting`
/// rejection from a current daemon, or the exact-message fallback that
/// also recognizes older daemons rejecting with the same plain string.
#[must_use]
pub fn is_update_restarting_rejection(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<RequestRejected>()
            .is_some_and(|rejected| {
                matches!(
                    &rejected.error_info,
                    Some(pa_types::daemon::DaemonErrorInfo::UpdateRestarting)
                ) || rejected.message == pa_types::daemon::UPDATE_RESTART_PREPARING_MESSAGE
            })
    })
}

/// Whether an error is a response/handshake timeout ("Timed out after
/// Nms waiting for the Prime Agent daemon (response|handshake)"): a
/// transient under-load failure, not a protocol error — the caller
/// degrades (retry or surface the queued state) instead of exiting.
#[must_use]
pub fn is_daemon_timeout(error: &anyhow::Error) -> bool {
    // Case-insensitive: the TUI's own bounded requests say
    // "timed out after Nms ...", the daemon client's hello/connect paths
    // "Timed out after Nms ...". ANCHORED at the chain link's start, the
    // shape of TS's own transport-timeout checks: every genuine emitter
    // begins its message with the phrase, so an error that merely
    // QUOTES a timeout (the update-restart wait's deadline error inlines
    // the last attempt's text) never matches and keeps its dedicated
    // guidance handoff.
    error.chain().any(|cause| {
        cause
            .to_string()
            .to_lowercase()
            .starts_with("timed out after")
    })
}

/// Whether an error means the daemon connection could not carry the
/// request at all (a timeout, or a closed connection): a transient the
/// submit path surfaces without exiting — the pane stays mounted for the
/// reconnect driver to restore the connection.
#[must_use]
pub fn is_daemon_unreachable(error: &anyhow::Error) -> bool {
    is_daemon_timeout(error)
        || error.chain().any(|cause| {
            let cause = cause.to_string().to_lowercase();
            cause.contains("daemon connection")
                || cause.contains("prime agent daemon closed")
                || cause.contains("direct session connection closed")
                || cause.contains("the session connection closed")
        })
}

/// Unwrap a settled response into its `data`, surfacing the daemon
/// refusal as a typed [`RequestRejected`] on failure.
pub(super) fn response_data_or_error(name: &str, response: DaemonResponse) -> Result<Value> {
    if !response.success {
        let message = response
            .error
            .unwrap_or_else(|| "unknown error".to_string());
        return Err(anyhow::Error::new(RequestRejected {
            command: name.to_string(),
            message,
            error_info: response.error_info,
        }));
    }
    Ok(response.data.unwrap_or(Value::Null))
}

/// The typed provider-unauthenticated refusal of a rejected request (the
/// daemon's `set_model` on a model whose provider is not signed in): the
/// provider id the client's sign-in flow should serve. `None` for every
/// other refusal and transport failure.
#[must_use]
pub fn rejected_provider_unauthenticated(error: &anyhow::Error) -> Option<String> {
    error
        .chain()
        .filter_map(|cause| cause.downcast_ref::<RequestRejected>())
        .find_map(|rejected| match &rejected.error_info {
            Some(DaemonErrorInfo::ModelProviderUnauthenticated { provider }) => {
                Some(provider.clone())
            }
            _ => None,
        })
}

/// Wire `type` tag of a command, for error messages.
pub(super) fn command_type_debug(command: &DaemonCommand) -> String {
    serde_json::to_value(command)
        .ok()
        .and_then(|value| value.get("type").cloned())
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "command".to_string())
}
