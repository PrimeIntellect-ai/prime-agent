//! The id + timestamp mint: the session id minters, the session file path, and the ISO-8601
//! timestamps.

use super::{HashMap, Path, PathBuf};

pub(super) fn generate_id(existing: &HashMap<String, usize>) -> String {
    for _ in 0..100 {
        let id = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
        if !existing.contains_key(&id) {
            return id;
        }
    }
    uuid::Uuid::new_v4().to_string()
}

pub(super) fn create_session_id() -> String {
    create_uuid_v7()
}

/// `UUIDv7` (timestamp-ordered, like the TS `createSessionId`).
fn create_uuid_v7() -> String {
    uuid::Uuid::now_v7().to_string()
}

#[must_use]
pub fn get_session_file_path(session_dir: &Path, session_id: &str) -> PathBuf {
    session_dir.join(format!("{session_id}.jsonl"))
}

#[must_use]
pub fn format_iso_now() -> String {
    // ISO-8601 with millisecond precision, like `new Date().toISOString()`.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let millis = now.as_millis();
    format_iso(millis as i64)
}

#[must_use]
pub fn format_iso(millis: i64) -> String {
    let days = millis.div_euclid(86_400_000);
    let time_ms = millis.rem_euclid(86_400_000);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    let hour = time_ms / 3_600_000;
    let minute = (time_ms / 60_000) % 60;
    let second = (time_ms / 1_000) % 60;
    let ms = time_ms % 1_000;
    format!("{y:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}.{ms:03}Z")
}
