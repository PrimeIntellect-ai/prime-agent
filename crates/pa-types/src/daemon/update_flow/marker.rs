//! `marker.json` — the durable self-expiry marker of a prepared update — and
//! the expiry verdict every consumer of the prepared directory must apply.

use serde::{Deserialize, Serialize};

use crate::JsonMap;

use super::artifact::UpdateId;

/// The supervisor identity recorded in update artifacts: `{pid,
/// process_start_id, generation}`. Shared by the prepared marker and the
/// roster snapshot (spec §7, §8).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateSupervisorIdentity {
    pub pid: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_start_id: Option<String>,
    pub generation: String,
}

/// `prepared/<update-id>/marker.json` (spec §7): written in the same durable
/// write as `roster.json` at `Snapshotted`. `expires_at` is what makes the
/// `Prepared` state self-expiring — the supervisor arms a timer against it and
/// re-checks it on any later command, and the coordinator reads it before
/// consuming the roster: an expired marker is a refusal, never a restore of
/// stale snapshots.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdatePreparedMarker {
    pub update_id: UpdateId,
    /// RFC 3339 timestamp; see [`prepared_marker_expiry`] for the verdict.
    pub expires_at: String,
    pub supervisor: UpdateSupervisorIdentity,
    #[serde(flatten)]
    pub rest: JsonMap,
}

/// The verdict of checking a marker's `expires_at` against the current time.
///
/// Both sides of the comparison come from RFC 3339 strings (the marker is
/// durable across process death, so wall-clock text is the contract), parsed
/// here without a date-time dependency: TS `new Date().toISOString()` output
/// (UTC, millisecond precision) and offset forms both parse.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreparedMarkerExpiry {
    /// `expires_at` is still in the future: the prepared directory authorizes
    /// the `Prepared -> Stopping` consumption.
    Active,
    /// The deadline passed: the prepared directory is garbage — the
    /// supervisor returns to `Serving`, the coordinator moves to `Aborted`.
    Expired,
    /// Either timestamp is malformed, so the verdict cannot be trusted: the
    /// prepared directory is treated as garbage and restore is refused.
    Malformed,
}

/// Decide whether a prepared marker still authorizes consumption at `now`.
/// A marker at exactly its deadline is expired: any command arriving after
/// expiry (inclusive) treats the prepared directory as garbage (spec §5).
pub fn prepared_marker_expiry(expires_at: &str, now: &str) -> PreparedMarkerExpiry {
    match (rfc3339_nanos(expires_at), rfc3339_nanos(now)) {
        (Some(expires), Some(now)) if now < expires => PreparedMarkerExpiry::Active,
        (Some(_), Some(_)) => PreparedMarkerExpiry::Expired,
        (None, _) | (_, None) => PreparedMarkerExpiry::Malformed,
    }
}

/// Parse an RFC 3339 timestamp into nanoseconds since the Unix epoch.
/// Accepts `YYYY-MM-DDTHH:MM:SS` with optional fractional seconds and a
/// `Z`/`±HH:MM`/`±HHMM`/`±HH` offset; returns `None` for anything else.
fn rfc3339_nanos(timestamp: &str) -> Option<i64> {
    let t = timestamp;
    let b = |i: usize| t.as_bytes().get(i).copied();
    if t.len() < 20 {
        return None;
    }
    let year = digits(t, 0, 4)?;
    if b(4) != Some(b'-') {
        return None;
    }
    let month = digits(t, 5, 2)?;
    if b(7) != Some(b'-') {
        return None;
    }
    let day = digits(t, 8, 2)?;
    if b(10) != Some(b'T') && b(10) != Some(b't') {
        return None;
    }
    let hour = digits(t, 11, 2)?;
    if b(13) != Some(b':') {
        return None;
    }
    let minute = digits(t, 14, 2)?;
    if b(16) != Some(b':') {
        return None;
    }
    let second = digits(t, 17, 2)?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        _ => return None,
    };
    if !(1..=max_day).contains(&day) || hour > 23 || minute > 59 || second > 59 {
        return None;
    }

    let mut idx = 19;
    let mut nanos = 0i64;
    if b(idx) == Some(b'.') {
        let start = idx + 1;
        let mut end = start;
        while b(end).is_some_and(|byte| byte.is_ascii_digit()) {
            end += 1;
        }
        if end == start {
            return None;
        }
        let mut scale = 100_000_000i64;
        for byte in t.as_bytes()[start..end].iter().take(9) {
            nanos += (byte - b'0') as i64 * scale;
            scale /= 10;
        }
        idx = end;
    }

    let offset_secs = match b(idx) {
        Some(b'Z' | b'z') => {
            if idx + 1 != t.len() {
                return None;
            }
            0
        }
        Some(sign @ (b'+' | b'-')) => {
            let rest = &t[idx + 1..];
            let (oh, om) = if rest.len() == 5 && rest.as_bytes().get(2) == Some(&b':') {
                (digits(rest, 0, 2)?, digits(rest, 3, 2)?)
            } else if rest.len() == 4 {
                (digits(rest, 0, 2)?, digits(rest, 2, 2)?)
            } else if rest.len() == 2 {
                (digits(rest, 0, 2)?, 0)
            } else {
                return None;
            };
            if om > 59 {
                return None;
            }
            let magnitude = oh * 3600 + om * 60;
            if sign == b'-' {
                -magnitude
            } else {
                magnitude
            }
        }
        _ => return None,
    };

    let days = days_from_civil(year, month as u64, day as u64);
    let secs = days * 86_400 + hour * 3600 + minute * 60 + second - offset_secs;
    Some(secs * 1_000_000_000 + nanos)
}

/// `d` ASCII digits of `s` starting at `start`, as an integer.
fn digits(s: &str, start: usize, len: usize) -> Option<i64> {
    let sub = s.get(start..start + len)?;
    if !sub.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    sub.parse::<i64>().ok()
}

/// Days since the Unix epoch for a civil (proleptic Gregorian) date.
fn days_from_civil(year: i64, month: u64, day: u64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy as i64;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_roundtrip_snake_case() {
        let json = r#"{"update_id":"018f1234-abcd-7abc-8def-0123456789ab","expires_at":"2026-10-01T12:00:45.000Z","supervisor":{"pid":4242,"process_start_id":"4242/170000","generation":"gen-7"},"note":"kept"}"#;
        let original: serde_json::Value = serde_json::from_str(json).unwrap();
        let parsed: UpdatePreparedMarker = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.supervisor.pid, 4242);
        let out = serde_json::to_string(&parsed).unwrap();
        let reparsed: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(original, reparsed);
    }

    #[test]
    fn marker_expires_at_behavior() {
        use PreparedMarkerExpiry::{Active, Expired, Malformed};
        // Still inside the 45 s window.
        assert_eq!(
            prepared_marker_expiry("2026-10-01T12:00:45.000Z", "2026-10-01T12:00:30.000Z"),
            Active
        );
        // Deadline passed — garbage.
        assert_eq!(
            prepared_marker_expiry("2026-10-01T12:00:45.000Z", "2026-10-01T12:01:00.000Z"),
            Expired
        );
        // The exact instant of expiry already counts as expired.
        assert_eq!(
            prepared_marker_expiry("2026-10-01T12:00:45.000Z", "2026-10-01T12:00:45.000Z"),
            Expired
        );
        // Sub-second precision decides both directions.
        assert_eq!(
            prepared_marker_expiry("2026-10-01T12:00:45.500Z", "2026-10-01T12:00:45.250Z"),
            Active
        );
        assert_eq!(
            prepared_marker_expiry("2026-10-01T12:00:45.250Z", "2026-10-01T12:00:45.500Z"),
            Expired
        );
        // Fractional-vs-plain seconds compare temporally, not lexically
        // (`.123Z` vs `Z` would sort the wrong way as raw strings).
        assert_eq!(
            prepared_marker_expiry("2026-10-01T12:00:00.123Z", "2026-10-01T12:00:00Z"),
            Active
        );
        assert_eq!(
            prepared_marker_expiry("2026-10-01T12:00:00Z", "2026-10-01T12:00:00.123Z"),
            Expired
        );
        // Offsets normalize to the same instant.
        assert_eq!(
            prepared_marker_expiry("2026-10-01T14:00:45+02:00", "2026-10-01T12:00:45.000Z"),
            Expired
        );
        // Malformed timestamps are garbage, never a silent decision.
        assert_eq!(
            prepared_marker_expiry("not-a-date", "2026-10-01T12:00:45.000Z"),
            Malformed
        );
        assert_eq!(
            prepared_marker_expiry("2026-10-01T12:00:45.000Z", "yesterday"),
            Malformed
        );
        assert_eq!(prepared_marker_expiry("", ""), Malformed);
    }

    #[test]
    fn rfc3339_parser_known_instants() {
        // Anchors cross-checked against a reference ISO-8601 implementation.
        assert_eq!(
            rfc3339_nanos("2026-10-01T12:00:00Z"),
            Some(1_790_856_000_000_000_000)
        );
        assert_eq!(
            rfc3339_nanos("2026-10-01T12:00:00.500Z"),
            Some(1_790_856_000_500_000_000)
        );
        assert_eq!(
            rfc3339_nanos("2026-10-01T12:00:00+00:00"),
            rfc3339_nanos("2026-10-01T12:00:00Z")
        );
        assert_eq!(
            rfc3339_nanos("2026-10-01T14:00:00+0200"),
            rfc3339_nanos("2026-10-01T12:00:00Z")
        );
        assert_eq!(
            rfc3339_nanos("2026-10-01T13:00:00+01"),
            rfc3339_nanos("2026-10-01T12:00:00Z")
        );
        // Year boundary through an offset form: same instant, one nanosecond
        // apart by construction of the strings.
        assert_eq!(
            rfc3339_nanos("2026-12-31T23:59:59Z"),
            rfc3339_nanos("2027-01-01T00:59:59+0100")
        );
        // Leap day in a leap year parses; in a non-leap year it is malformed.
        assert_eq!(
            rfc3339_nanos("2028-02-29T00:00:00Z"),
            Some(1_835_395_200_000_000_000)
        );
        assert_eq!(rfc3339_nanos("2026-02-29T00:00:00Z"), None);
        assert_eq!(rfc3339_nanos("2026-10-01T12:00:60Z"), None);
        assert_eq!(rfc3339_nanos("2026-13-01T12:00:00Z"), None);
        assert_eq!(rfc3339_nanos("2026-10-32T12:00:00Z"), None);
        assert_eq!(rfc3339_nanos("2026-04-31T12:00:00Z"), None);
        assert_eq!(rfc3339_nanos("2026-10-01T24:00:00Z"), None);
        assert_eq!(rfc3339_nanos("2026-10-01T12:00:00"), None);
        assert_eq!(rfc3339_nanos("2026-10-01 12:00:00Z"), None);
        assert_eq!(rfc3339_nanos("2026-10-01T12:00:00."), None);
    }
}
