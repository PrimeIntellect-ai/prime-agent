//! Timestamp helpers for the update flow's status and intent files
//! (`YYYY-MM-DDTHH:MM:SS.mmmZ`, the TS `new Date().toISOString()` shape).

use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

/// The current instant as ISO-8601 with millisecond precision (the TS
/// `toISOString()` shape the status file records).
pub fn now_iso8601() -> String {
    pa_daemon::util::iso_from_unix_ms(now_ms())
}
