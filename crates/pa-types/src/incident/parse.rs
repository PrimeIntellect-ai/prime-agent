//! Log-line parsing for the incident classifier (TS
//! `parseIncidentLogLine` / `parseIncidentDaemonLogLine` and the
//! `timestampToMs` helper).

use super::IncidentLogEntry;
use regex::Regex;
use std::sync::LazyLock;

/// `[<ISO>] supervisor: <msg>` or `[<ISO>] <msg>` (TS
/// `parseIncidentDaemonLogLine`).
static DAEMON_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\[([^\]]+)\]\s*(.*)$").expect("valid daemon line pattern"));

/// `~/.prime/agent/logs/agent.jsonl` is written with `Z`-suffixed ISO
/// timestamps (the daemon's `now_iso`); the daemon-log fallback's
/// bracketed timestamps carry the same zone. This parser accepts the
/// `Date.parse` subset the daemon emits: `YYYY-MM-DD` (UTC midnight),
/// optionally followed by `[T ]HH:MM[:SS[.fff...]]` and a zone (`Z` or
/// `±HH:MM` / `±HHMM`). A date-time without a zone parses as UTC — the
/// TS `Date.parse` would read the local zone there, but no daemon log
/// line is ever emitted without one, and the incident window itself is
/// UTC-end-to-end.
pub fn timestamp_to_ms(ts: &str) -> Option<i64> {
    let ts = ts.trim();
    let mut rest = ts;
    let year = i64::from(take_digits(&mut rest, 4)?);
    rest = rest.strip_prefix('-')?;
    let month: u32 = take_digits(&mut rest, 2)?;
    rest = rest.strip_prefix('-')?;
    let day: u32 = take_digits(&mut rest, 2)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    // Time-of-day and zone are optional: a date-only timestamp is UTC
    // midnight, matching `Date.parse("2026-09-10")`.
    let mut hour = 0u32;
    let mut minute = 0u32;
    let mut second = 0u32;
    let mut millis = 0i64;
    let mut offset_ms = 0i64;
    if let Some(after_date) = rest.strip_prefix('T').or(rest.strip_prefix(' ')) {
        rest = after_date;
        hour = take_digits(&mut rest, 2)?;
        rest = rest.strip_prefix(':')?;
        minute = take_digits(&mut rest, 2)?;
        if let Some(after_minute) = rest.strip_prefix(':') {
            rest = after_minute;
            second = take_digits(&mut rest, 2)?;
            if let Some(after_seconds) = rest.strip_prefix('.') {
                rest = after_seconds;
                // Any fraction length parses, scaled to milliseconds
                // (`.7` is 700ms like `new Date`).
                let mut digits = String::new();
                while rest.chars().next().is_some_and(|c| c.is_ascii_digit()) {
                    digits.push(rest.chars().next().unwrap_or_default());
                    rest = &rest[1..];
                }
                if digits.is_empty() {
                    return None;
                }
                let scaled: String = std::iter::once('0').chain(digits.chars().take(3)).collect();
                millis = scaled.parse::<i64>().ok()?;
            }
        }
        if rest.is_empty() {
            // A date-time without a zone reads as UTC (see the doc
            // comment); every daemon-emitted timestamp carries `Z`.
        } else if rest == "Z" {
        } else {
            let sign = match rest.chars().next()? {
                '+' => 1i64,
                '-' => -1i64,
                _ => return None,
            };
            rest = &rest[1..];
            let zone_hour = take_digits(&mut rest, 2)?;
            let zone_minute = if rest.is_empty() {
                0u32
            } else {
                rest = rest.strip_prefix(':').unwrap_or(rest);
                take_digits(&mut rest, 2)?
            };
            if !rest.is_empty() || zone_hour > 23 || zone_minute > 59 {
                return None;
            }
            offset_ms = sign * (zone_hour as i64 * 3_600_000 + zone_minute as i64 * 60_000);
        }
    } else if !rest.is_empty() {
        return None;
    }
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let days = days_from_civil(year, month, day)?;
    // The date must round-trip: `2026-02-31` is not a day (Date.parse
    // returns NaN there; the line is skipped as unreadable).
    if civil_from_days(days) != (year, month, day) {
        return None;
    }
    Some(
        days * 86_400_000
            + hour as i64 * 3_600_000
            + minute as i64 * 60_000
            + second as i64 * 1_000
            + millis
            - offset_ms,
    )
}

/// Take exactly `len` ASCII digits off the front of `rest`.
fn take_digits(rest: &mut &str, len: usize) -> Option<u32> {
    let bytes = rest.as_bytes();
    if bytes.len() < len || !bytes[..len].iter().all(u8::is_ascii_digit) {
        return None;
    }
    let value = rest[..len].parse().ok()?;
    *rest = &rest[len..];
    Some(value)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's
/// `days_from_civil`); `None` for a date outside the i64 epoch-day range.
fn days_from_civil(year: i64, month: u32, day: u32) -> Option<i64> {
    let month = month as i64;
    let day = day as i64;
    if !(-999_999_999..=999_999_999).contains(&year) {
        return None;
    }
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

/// `(year, month, day)` for days since 1970-01-01 (Howard Hinnant's
/// `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    (year, month as u32, day as u32)
}

/// Parse one `agent.jsonl` line; malformed lines return `None` (TS
/// `parseIncidentLogLine`).
pub fn parse_incident_log_line(line: &str) -> Option<IncidentLogEntry> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_str(trimmed).ok()?;
    let record = parsed.as_object()?;
    let ts = record.get("ts")?.as_str()?;
    let msg = record.get("msg")?.as_str()?.to_string();
    let time_ms = timestamp_to_ms(ts)?;
    Some(IncidentLogEntry {
        time_ms,
        level: record
            .get("level")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("warn")
            .to_string(),
        component: record
            .get("component")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        msg,
        socket_path: record
            .get("socketPath")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        pid: record.get("pid").and_then(pid_number),
        fields: record.clone(),
    })
}

/// The pid field accepts any integral JSON number (the daemon writes
/// integer pids; a non-integral one is not a pid sighting).
fn pid_number(value: &serde_json::Value) -> Option<i64> {
    value.as_i64().or_else(|| {
        value
            .as_f64()
            .filter(|n| n.fract() == 0.0)
            .map(|n| n as i64)
    })
}

/// Parse one per-daemon log line: `[<ISO>] supervisor: <msg>` or
/// `[<ISO>] <msg>` (TS `parseIncidentDaemonLogLine`).
pub fn parse_incident_daemon_log_line(line: &str) -> Option<IncidentLogEntry> {
    let captures = DAEMON_LINE.captures(line.trim())?;
    let ts = captures.get(1)?.as_str();
    let rest = captures.get(2)?.as_str();
    if ts.is_empty() || rest.trim().is_empty() {
        return None;
    }
    let time_ms = timestamp_to_ms(ts)?;
    let supervisor_line = rest.starts_with("supervisor:");
    let msg = if supervisor_line {
        rest.strip_prefix("supervisor:")?.trim()
    } else {
        rest
    };
    if msg.is_empty() {
        return None;
    }
    Some(IncidentLogEntry {
        time_ms,
        level: "warn".to_string(),
        component: if supervisor_line {
            "coding-agent.daemon-supervisor".to_string()
        } else {
            "coding-agent.daemon".to_string()
        },
        msg: msg.to_string(),
        socket_path: None,
        pid: None,
        fields: serde_json::Map::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamp_parses_the_daemon_shapes() {
        assert_eq!(
            timestamp_to_ms("2026-09-10T20:00:00.000Z"),
            Some(1_789_070_400_000)
        );
        // The motivating incident's window (the TS test's `Date.parse`
        // ground truth).
        assert_eq!(
            timestamp_to_ms("2026-09-10T20:00:00Z"),
            Some(1_789_070_400_000)
        );
        // Date-only is UTC midnight.
        assert_eq!(timestamp_to_ms("2026-09-10"), Some(1_789_070_400_000));
        // Fractional seconds scale.
        assert_eq!(
            timestamp_to_ms("2026-09-10T20:00:00.7Z"),
            Some(1_789_070_400_700)
        );
        assert_eq!(
            timestamp_to_ms("2026-09-10T20:00:00.764Z"),
            Some(1_789_070_400_764)
        );
        // A zone offset shifts.
        assert_eq!(
            timestamp_to_ms("2026-09-10T22:02+02:00"),
            Some(1_789_070_520_000)
        );
        assert_eq!(
            timestamp_to_ms("2026-09-10T22:02+0200"),
            Some(1_789_070_520_000)
        );
        // Pre-epoch timestamps stay exact.
        assert_eq!(timestamp_to_ms("1969-12-31T23:59:59.999Z"), Some(-1));
    }

    #[test]
    fn timestamp_rejects_impossible_and_malformed_values() {
        assert_eq!(timestamp_to_ms("not-a-timestamp"), None);
        assert_eq!(timestamp_to_ms(""), None);
        assert_eq!(timestamp_to_ms("2026-13-01"), None);
        assert_eq!(timestamp_to_ms("2026-09-32"), None);
        assert_eq!(timestamp_to_ms("2026-02-31T00:00:00Z"), None);
        assert_eq!(timestamp_to_ms("2026-09-10T25:00:00Z"), None);
        assert_eq!(timestamp_to_ms("2026-09-10T20:00:00."), None);
        assert_eq!(timestamp_to_ms("2026-09-10T20:00:00+25:00"), None);
        assert_eq!(timestamp_to_ms("2026-09-10T20:00:00+02:60"), None);
    }

    #[test]
    fn log_line_parses_the_structured_record() {
        let entry = parse_incident_log_line(
            r#"{"ts":"2026-09-10T20:02:53.374Z","level":"error","component":"ai.provider","pid":53615,"msg":"provider stream failure","kind":"rate_limit","status":429}"#,
        )
        .expect("valid line");
        assert_eq!(entry.time_ms, 1_789_070_573_374);
        assert_eq!(entry.level, "error");
        assert_eq!(entry.component, "ai.provider");
        assert_eq!(entry.pid, Some(53615));
        assert_eq!(entry.socket_path, None);
        assert_eq!(
            entry.fields.get("kind").and_then(serde_json::Value::as_str),
            Some("rate_limit")
        );
        assert_eq!(
            entry
                .fields
                .get("status")
                .and_then(serde_json::Value::as_i64),
            Some(429)
        );
    }

    #[test]
    fn log_line_defaults_level_and_component() {
        let entry = parse_incident_log_line(r#"{"ts":"2026-09-10T20:00:00Z","msg":"hi"}"#)
            .expect("valid line");
        assert_eq!(entry.level, "warn");
        assert_eq!(entry.component, "unknown");
    }

    #[test]
    fn log_line_skips_malformed_records() {
        assert!(parse_incident_log_line("").is_none());
        assert!(parse_incident_log_line("   ").is_none());
        assert!(parse_incident_log_line("this is not json").is_none());
        assert!(parse_incident_log_line(r#"{"noTs":true,"msg":"missing ts"}"#).is_none());
        assert!(parse_incident_log_line(r#"{"ts":123,"msg":"ts must be a string"}"#).is_none());
        assert!(parse_incident_log_line(r#"{"ts":"garbage","msg":true}"#).is_none());
        assert!(parse_incident_log_line(r#"{"ts":"2026-09-10T20:00:00Z"}"#).is_none());
        assert!(parse_incident_log_line(r#"["an","array"]"#).is_none());
    }

    #[test]
    fn daemon_log_line_parses_supervisor_and_worker_lines() {
        let supervisor = parse_incident_daemon_log_line(
            "[2026-09-10T20:02:39.765Z] supervisor: Supervisor command attach failed: Error: Timed out waiting for daemon worker response to attach",
        )
        .expect("supervisor line");
        assert_eq!(supervisor.component, "coding-agent.daemon-supervisor");
        assert_eq!(
            supervisor.msg,
            "Supervisor command attach failed: Error: Timed out waiting for daemon worker response to attach"
        );
        assert_eq!(supervisor.time_ms, 1_789_070_559_765);
        assert_eq!(supervisor.level, "warn");
        assert_eq!(supervisor.pid, None);

        let worker = parse_incident_daemon_log_line(
            "[2026-09-10T20:23:24.945Z] uncaught exception: Error: write EPIPE",
        )
        .expect("worker line");
        assert_eq!(worker.component, "coding-agent.daemon");
        assert_eq!(worker.msg, "uncaught exception: Error: write EPIPE");
    }

    #[test]
    fn daemon_log_line_skips_malformed_lines() {
        assert!(parse_incident_daemon_log_line("not a log line").is_none());
        assert!(parse_incident_daemon_log_line("[not-a-timestamp] supervisor: msg").is_none());
        assert!(parse_incident_daemon_log_line("[]").is_none());
        assert!(parse_incident_daemon_log_line("[2026-09-10T20:00:00Z]   ").is_none());
        assert!(parse_incident_daemon_log_line("[2026-09-10T20:00:00Z] supervisor:").is_none());
    }
}
