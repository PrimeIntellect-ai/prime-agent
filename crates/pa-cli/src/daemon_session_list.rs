//! Session-list rendering for the `list` command: summary validation, display
//! ids, and the fixed-column table, ported from `cli/daemon-list-format.ts`,
//! `core/session-id.ts`, and the summary guards in `cli/daemon-command.ts`.

use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

/// 12-char display id, mirroring `DISPLAY_ID_LENGTH`.
const DISPLAY_ID_LENGTH: usize = 12;

/// Display order for the status column.
const LIST_STATUS_ORDER: [&str; 3] = ["working", "idle", "archived"];

/// A validated session summary row ready for the table.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SessionSummary {
    id: String,
    session_id: String,
    session_name: Option<String>,
    lifecycle: String,
    activity: String,
    modified: Option<String>,
    model: Option<(String, String)>,
    message_count: u64,
    attached_clients: u64,
    active_session_id: Option<String>,
}

impl SessionSummary {
    /// The derived list status: `archived` by lifecycle, else working/idle.
    fn list_status(&self) -> &str {
        if self.lifecycle == "archived" {
            "archived"
        } else if self.activity == "working" {
            "working"
        } else {
            "idle"
        }
    }

    fn list_status_order(&self) -> usize {
        LIST_STATUS_ORDER
            .iter()
            .position(|status| *status == self.list_status())
            .unwrap_or(LIST_STATUS_ORDER.len())
    }
}

/// `isSessionSummary`: a structural guard so malformed daemon rows fall back
/// to raw JSON output exactly like the TS client.
fn is_session_summary(value: &Value) -> bool {
    if !value.is_object() {
        return false;
    }
    string_field(value, "id").is_some()
        && string_field(value, "sessionId").is_some()
        && string_field(value, "cwd").is_some()
        && string_field(value, "lifecycle").is_some()
        && string_field(value, "activity").is_some()
        && bool_field(value, "isSessionActive").is_some()
        && bool_field(value, "isStreaming").is_some()
        && bool_field(value, "isCompacting").is_some()
        && number_field(value, "attachedClients").is_some()
        && number_field(value, "messageCount").is_some()
        && (value.get("unfinishedActionCount").is_none()
            || number_field(value, "unfinishedActionCount").is_some())
        && value.get("sessionActions").is_some_and(Value::is_object)
        && number_field(value, "sessionActions.queuedCount").is_some()
        && pointer(value, "sessionActions.steering").is_some_and(Value::is_array)
        && pointer(value, "sessionActions.followUps").is_some_and(Value::is_array)
}

pub(crate) fn string_field<'a>(value: &'a Value, path: &str) -> Option<&'a str> {
    pointer(value, path).and_then(Value::as_str)
}

fn bool_field(value: &Value, path: &str) -> Option<bool> {
    pointer(value, path).and_then(Value::as_bool)
}

fn number_field(value: &Value, path: &str) -> Option<f64> {
    pointer(value, path).and_then(Value::as_f64)
}

/// JSON-pointer-lite lookup for the nested action fields.
fn pointer<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.')
        .try_fold(value, |current, key| current.get(key))
}

/// `isLiveSessionSummary`: a session summary with a routable active id.
fn is_live_session_summary(value: &Value) -> bool {
    is_session_summary(value) && string_field(value, "activeSessionId").is_some()
}

fn session_summary_from_value(value: &Value) -> Option<SessionSummary> {
    if !is_session_summary(value) {
        return None;
    }
    let model = value.get("model").and_then(|model| {
        let provider = model.get("provider")?.as_str()?.to_string();
        let id = model.get("id")?.as_str()?.to_string();
        Some((provider, id))
    });
    Some(SessionSummary {
        id: string_field(value, "id")?.to_string(),
        session_id: string_field(value, "sessionId")?.to_string(),
        session_name: string_field(value, "sessionName").map(str::to_string),
        lifecycle: string_field(value, "lifecycle")?.to_string(),
        activity: string_field(value, "activity")?.to_string(),
        modified: string_field(value, "modified").map(str::to_string),
        model,
        message_count: number_field(value, "messageCount")? as u64,
        attached_clients: number_field(value, "attachedClients")? as u64,
        active_session_id: string_field(value, "activeSessionId").map(str::to_string),
    })
}

/// `getSessionSummaries` for surfaces that read the wire rows directly (the
/// sessions table): `Some(rows)` when every row validates, else `None` so
/// the caller prints raw JSON like the TS client.
pub(crate) fn validated_session_values(data: &Value) -> Option<Vec<&Value>> {
    let sessions = data.get("sessions")?.as_array()?;
    sessions
        .iter()
        .map(|session| is_session_summary(session).then_some(session))
        .collect()
}

/// `getSessionSummaries`: `Some(rows)` when every row validates, else `None`
/// so the caller prints raw JSON like the TS client.
pub(crate) fn get_session_summaries(data: &Value) -> Option<Vec<SessionSummary>> {
    validated_session_values(data)?
        .iter()
        .map(|session| session_summary_from_value(session))
        .collect()
}

/// `isLiveSessionSummary` as a public guard for create/rename output paths.
pub(crate) fn live_session_summary(data: &Value) -> Option<&Value> {
    is_live_session_summary(data).then_some(data)
}

/// The shared CLI table renderer (TS `formatTable`): every column pads to
/// the widest cell's terminal display width, so a wide glyph (CJK, emoji)
/// cannot drift the columns after it. Two spaces separate columns.
pub(crate) fn format_table<const N: usize>(headers: &[&str; N], rows: &[[String; N]]) -> String {
    let widths: [usize; N] = std::array::from_fn(|column| {
        rows.iter()
            .map(|row| pa_tui::width::str_width(&row[column]))
            .chain(std::iter::once(pa_tui::width::str_width(headers[column])))
            .max()
            .unwrap_or(0)
    });
    let padded_row = |row: &[String; N]| {
        row.iter()
            .zip(widths)
            .map(|(cell, width)| pa_tui::width::pad_cell(cell, width))
            .collect::<Vec<_>>()
            .join("  ")
    };
    let header_row: [String; N] = std::array::from_fn(|column| headers[column].to_string());
    let mut lines = vec![padded_row(&header_row)];
    for row in rows {
        lines.push(padded_row(row));
    }
    lines.join("\n")
}

/// The `list` table's columns.
const LIST_HEADERS: [&str; 7] = [
    "name", "id", "status", "age", "model", "messages", "clients",
];

/// The fixed-column table, mirroring `formatSessionListTable` (colors are
/// TTY-only in TS; this output is color-free like TS piped output).
pub(crate) fn format_session_list_table(sessions: &[SessionSummary]) -> String {
    let now = now_ms();
    let mut sorted: Vec<&SessionSummary> = sessions.iter().collect();
    sorted.sort_by_key(|session| session.list_status_order());
    let rows: Vec<[String; 7]> = sorted
        .iter()
        .map(|session| {
            [
                session.session_name.clone().unwrap_or_default(),
                format_session_display_id(&session.id),
                session.list_status().to_string(),
                format_session_age(session.modified.as_deref(), now),
                session
                    .model
                    .as_ref()
                    .map(|(provider, id)| format!("{provider}/{id}"))
                    .unwrap_or_default(),
                session.message_count.to_string(),
                session.attached_clients.to_string(),
            ]
        })
        .collect();
    format_table(&LIST_HEADERS, &rows)
}

/// `formatSessionDisplayId`: the last 12 chars of a hex-normalized id.
pub(crate) fn format_session_display_id(id: &str) -> String {
    let normalized = normalize_session_id(id);
    if is_hex(&normalized) {
        return tail(&normalized, DISPLAY_ID_LENGTH);
    }
    tail(id, DISPLAY_ID_LENGTH)
}

/// `matchesSessionIdSuffix`: hex-suffix matching for short selectors.
pub(crate) fn matches_session_id_suffix(candidate: &str, suffix: &str) -> bool {
    let normalized_candidate = normalize_session_id(candidate);
    let normalized_suffix = normalize_session_id(suffix);
    is_hex(&normalized_candidate)
        && is_hex(&normalized_suffix)
        && normalized_candidate.ends_with(&normalized_suffix)
}

fn normalize_session_id(id: &str) -> String {
    id.replace('-', "").to_lowercase()
}

fn is_hex(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|c| c.is_ascii_hexdigit())
}

fn tail(value: &str, length: usize) -> String {
    if value.chars().count() > length {
        let skip = value.chars().count() - length;
        value.chars().skip(skip).collect()
    } else {
        value.to_string()
    }
}

/// `formatSessionAge`: `<n>s|m|h|d|w|y` bucketing from the modified timestamp.
pub(crate) fn format_session_age(modified: Option<&str>, now_ms: u64) -> String {
    let Some(modified) = modified else {
        return String::new();
    };
    let Some(modified_ms) = parse_iso_ms(modified) else {
        return String::new();
    };
    let age_seconds = now_ms.saturating_sub(modified_ms) / 1000;
    if age_seconds < 60 {
        return format!("{age_seconds}s");
    }
    let age_minutes = age_seconds / 60;
    if age_minutes < 60 {
        return format!("{age_minutes}m");
    }
    let age_hours = age_minutes / 60;
    if age_hours < 24 {
        return format!("{age_hours}h");
    }
    let age_days = age_hours / 24;
    if age_days < 7 {
        return format!("{age_days}d");
    }
    let age_weeks = age_days / 7;
    if age_weeks < 52 {
        return format!("{age_weeks}w");
    }
    format!("{}y", age_weeks / 52)
}

/// RFC 3339 timestamp to epoch milliseconds, the subset `new Date(text)`
/// accepts for daemon timestamps (UTC `Z`-suffixed ISO strings).
pub(crate) fn parse_iso_ms(text: &str) -> Option<u64> {
    let text = text.trim();
    let (date, rest) = text.split_once('T')?;
    let (time, offset_ms) = if let Some(time) = rest.strip_suffix('Z') {
        (time, 0i64)
    } else {
        let index = rest
            .rfind('+')
            .or_else(|| rest[1..].rfind('-').map(|i| i + 1))?;
        let offset = parse_offset(&rest[index..])?;
        (&rest[..index], offset)
    };
    let (year, month, day) = parse_date_parts(date)?;
    let (hour, minute, second, millis) = parse_time_parts(time)?;
    let days = days_from_civil(year, month, day);
    let ms = days * 86_400_000
        + hour as i64 * 3_600_000
        + minute as i64 * 60_000
        + second as i64 * 1_000
        + millis as i64
        - offset_ms;
    u64::try_from(ms).ok()
}

fn parse_date_parts(date: &str) -> Option<(i64, u32, u32)> {
    let mut parts = date.split('-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: u32 = parts.next()?.parse().ok()?;
    let day: u32 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some((year, month, day))
}

fn parse_time_parts(time: &str) -> Option<(u32, u32, u32, u32)> {
    let mut parts = time.split(':');
    let hour: u32 = parts.next()?.parse().ok()?;
    let minute: u32 = parts.next()?.parse().ok()?;
    let seconds_text = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let (second, millis) = match seconds_text.split_once('.') {
        Some((second, fraction)) => {
            let second: u32 = second.parse().ok()?;
            let digits: String = fraction.chars().take(3).collect();
            let millis = fraction_millis(&digits)?;
            (second, millis)
        }
        None => (seconds_text.parse().ok()?, 0),
    };
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    Some((hour, minute, second, millis))
}

/// Fractional seconds to milliseconds, scaled like `new Date` parsing
/// (`.27` is 270ms, not 27ms).
fn fraction_millis(digits: &str) -> Option<u32> {
    let value: u32 = digits.parse().ok()?;
    match digits.len() {
        1 => Some(value * 100),
        2 => Some(value * 10),
        3 => Some(value),
        _ => None,
    }
}

fn parse_offset(offset: &str) -> Option<i64> {
    let sign = match offset.as_bytes().first()? {
        b'+' => 1i64,
        b'-' => -1i64,
        _ => return None,
    };
    let mut parts = offset[1..].split(':');
    let hours: i64 = parts.next()?.parse().ok()?;
    let minutes: i64 = parts.next().unwrap_or("0").parse().ok()?;
    Some(sign * (hours * 3_600_000 + minutes * 60_000))
}

/// Days since the epoch from a civil date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if month > 2 {
        month as i64 - 3
    } else {
        month as i64 + 9
    };
    let doy = (153 * mp + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn summary() -> Value {
        json!({
            "id": "b72ad7009b11",
            "sessionId": "01a0ab7c-0239-74b8-97ba-5db0e6ff35ae",
            "activeSessionId": "b72ad7009b11",
            "sessionName": "research",
            "cwd": "/tmp/pa-golden/work",
            "lifecycle": "resident",
            "activity": "idle",
            "isSessionActive": false,
            "isStreaming": false,
            "isCompacting": false,
            "attachedClients": 0,
            "messageCount": 3,
            "unfinishedActionCount": 0,
            "modified": "2026-09-16T18:30:26.272Z",
            "model": { "id": "z-ai/glm-5.3", "provider": "prime-inference" },
            "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
        })
    }

    #[test]
    fn table_matches_captured_ts_golden_shape() {
        let sessions = get_session_summaries(&json!({ "sessions": [summary()] })).unwrap();
        let table = format_session_list_table(&sessions);
        let lines: Vec<&str> = table.lines().collect();
        assert_eq!(
            lines[0],
            "name      id            status  age  model                         messages  clients"
        );
        assert!(
            lines[1].starts_with("research  b72ad7009b11  idle"),
            "{lines:?}"
        );
        assert!(
            lines[1].contains("prime-inference/z-ai/glm-5.3"),
            "{lines:?}"
        );
    }

    #[test]
    fn archived_rows_sort_after_idle() {
        let mut archived = summary();
        archived["lifecycle"] = json!("archived");
        let mut working = summary();
        working["activity"] = json!("working");
        let sessions =
            get_session_summaries(&json!({ "sessions": [archived, working, summary()] })).unwrap();
        let table = format_session_list_table(&sessions);
        let lines: Vec<&str> = table.lines().collect();
        assert!(lines[1].contains("working"), "{lines:?}");
        assert!(lines[2].contains("idle"), "{lines:?}");
        assert!(lines[3].contains("archived"), "{lines:?}");
    }

    #[test]
    fn malformed_rows_do_not_validate() {
        let mut broken = summary();
        broken["attachedClients"] = json!("many");
        assert!(get_session_summaries(&json!({ "sessions": [broken] })).is_none());
    }

    #[test]
    fn display_id_uses_last_hex_chars() {
        assert_eq!(
            format_session_display_id("01a0ab7c-0239-74b8-97ba-5db0e6ff35ae"),
            "5db0e6ff35ae"
        );
        assert_eq!(format_session_display_id("short"), "short");
        assert_eq!(format_session_display_id("n"), "n");
    }

    #[test]
    fn suffix_matching_normalizes_both_sides() {
        assert!(matches_session_id_suffix(
            "01a0ab7c-0239-74b8-97ba-5db0e6ff35ae",
            "5db0e6ff35ae"
        ));
        assert!(!matches_session_id_suffix("worker-abc", "abc"));
    }

    #[test]
    fn age_buckets_like_ts() {
        let now = 1_789_583_426_272u64; // 2026-09-16T18:30:26.272Z
        assert_eq!(
            format_session_age(Some("2026-09-16T18:30:26.272Z"), now),
            "0s"
        );
        assert_eq!(
            format_session_age(Some("2026-09-16T18:29:26.272Z"), now),
            "1m"
        );
        assert_eq!(
            format_session_age(Some("2026-09-16T17:30:26.272Z"), now),
            "1h"
        );
        assert_eq!(
            format_session_age(Some("2026-09-15T18:30:26.272Z"), now),
            "1d"
        );
        assert_eq!(
            format_session_age(Some("2026-09-09T18:30:26.272Z"), now),
            "1w"
        );
        assert_eq!(format_session_age(None, now), "");
    }

    #[test]
    fn iso_parse_round_trips_known_values() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(
            parse_iso_ms("2026-09-16T18:30:26.272Z"),
            Some(1_789_583_426_272)
        );
        assert_eq!(
            parse_iso_ms("2026-09-16T18:30:26Z"),
            Some(1_789_583_426_000)
        );
        assert_eq!(
            parse_iso_ms("2026-09-16T18:30:26.272+02:00"),
            Some(1_789_583_426_272 - 7_200_000)
        );
        assert_eq!(
            parse_iso_ms("2026-09-16T18:30:26.272-00:30"),
            Some(1_789_583_426_272 + 1_800_000)
        );
        assert_eq!(parse_iso_ms("bogus"), None);
    }
}
