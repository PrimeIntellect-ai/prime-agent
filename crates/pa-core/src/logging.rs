//! Structured-log bootstrap: install the pa-ai logger's process-wide sink on
//! stderr. Worker stderr is captured per worker (`worker-<id>.stderr.log`), so
//! provider-auth events (token refreshes, rejections) reach a durable log file
//! without a new surface; CLI runs see them on the terminal.

/// Install the process-wide stderr sink for [`pa_ai::utils::log`]: one JSON
/// line per entry. Idempotent per process by construction (callers install at
/// entry); a write failure (closed stderr) is swallowed — logging must never
/// throw into the caller.
pub fn install_stderr_log_sink() {
    pa_ai::utils::log::set_log_sink(Some(std::sync::Arc::new(|entry| {
        let line = serde_json::to_string(entry).unwrap_or_default();
        eprintln!("{line}");
    })));
}
