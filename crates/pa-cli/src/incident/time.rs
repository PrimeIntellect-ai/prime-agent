//! `--since`/`--until` time parsing and the timeline's UTC stamp (TS
//! `parseIncidentTimeBound` / `formatIncidentTime`).

use super::IncidentUsageError;

/// Milliseconds since the Unix epoch (the TS `Date` time value).
pub(crate) type EpochMs = i64;

/// Parse a `--since`/`--until` bound. Times without a timezone are read
/// as UTC, matching the timestamps the daemon logs; "20:02" means today
/// at 20:02 UTC (TS `parseIncidentTimeBound`).
///
/// # Errors
///
/// Returns [`IncidentUsageError`] for a value that is not an ISO
/// date-time, a date, or a bare `HH:MM` today, or for an impossible date
/// or an invalid timezone offset.
pub(crate) fn parse_incident_time_bound(
    value: &str,
    now_ms: EpochMs,
    flag: &str,
) -> Result<EpochMs, IncidentUsageError> {
    let raw = value.trim();
    if raw.is_empty() {
        return Err(IncidentUsageError(format!("{flag} requires a time.")));
    }
    let invalid = || {
        IncidentUsageError(format!(
            "Invalid time for {flag}: \"{value}\". Use \"2026-09-16T20:02\", \"2026-09-16\", or \"20:02\" (today, UTC)."
        ))
    };
    // `^(\d{2}):(\d{2})$` — a bare time reads as today, UTC.
    if raw.len() == 5 && raw.as_bytes()[2] == b':' {
        if let (Some(hour), Some(minute)) = (digits(&raw[..2]), digits(&raw[3..])) {
            if hour > 23 || minute > 59 {
                return Err(invalid());
            }
            // Today's UTC midnight plus the given time of day.
            let midnight = now_ms.div_euclid(86_400_000) * 86_400_000;
            return Ok(midnight + hour as i64 * 3_600_000 + minute as i64 * 60_000);
        }
    }
    // `^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?$`
    let mut rest = raw;
    let Some(year) = take_digits(&mut rest, 4).map(i64::from) else {
        return Err(invalid());
    };
    if !rest.starts_with('-') {
        return Err(invalid());
    }
    rest = &rest[1..];
    let Some(month) = take_digits(&mut rest, 2) else {
        return Err(invalid());
    };
    if !rest.starts_with('-') {
        return Err(invalid());
    }
    rest = &rest[1..];
    let Some(day) = take_digits(&mut rest, 2) else {
        return Err(invalid());
    };
    let mut hour: Option<u32> = None;
    let mut minute: Option<u32> = None;
    let mut second = 0u32;
    let mut millis = 0i64;
    if let Some(after_date) = rest.strip_prefix(['T', ' ']) {
        rest = after_date;
        let Some(parsed_hour) = take_digits(&mut rest, 2) else {
            return Err(invalid());
        };
        hour = Some(parsed_hour);
        if !rest.starts_with(':') {
            return Err(invalid());
        }
        rest = &rest[1..];
        let Some(parsed_minute) = take_digits(&mut rest, 2) else {
            return Err(invalid());
        };
        minute = Some(parsed_minute);
        if let Some(after_minute) = rest.strip_prefix(':') {
            rest = after_minute;
            let Some(parsed_second) = take_digits(&mut rest, 2) else {
                return Err(invalid());
            };
            second = parsed_second;
            if let Some(after_seconds) = rest.strip_prefix('.') {
                rest = after_seconds;
                // `(\d{1,3})`: one to three fraction digits, `.7` is 700ms.
                let mut digits = String::new();
                while digits.len() < 3 && rest.chars().next().is_some_and(|c| c.is_ascii_digit()) {
                    digits.push(rest.chars().next().unwrap_or_default());
                    rest = &rest[1..];
                }
                if digits.is_empty() {
                    return Err(invalid());
                }
                while digits.len() < 3 {
                    digits.push('0');
                }
                millis = digits.parse::<i64>().map_err(|_| invalid())?;
            }
        }
    }
    let mut offset_minutes: Option<i64> = None;
    if rest.is_empty() {
        // No zone: the bound reads as UTC, matching the log.
    } else if rest == "Z" {
    } else {
        let sign = match rest.chars().next() {
            Some('+') => 1i64,
            Some('-') => -1i64,
            _ => return Err(invalid()),
        };
        rest = &rest[1..];
        let Some(zone_hour) = take_digits(&mut rest, 2) else {
            return Err(invalid());
        };
        // `(?::?\d{2})?` — optional minutes behind an optional colon.
        let zone_minute = if let Some(after_colon) = rest.strip_prefix(':') {
            rest = after_colon;
            take_digits(&mut rest, 2).ok_or_else(invalid)? as i64
        } else {
            take_digits(&mut rest, 2).map_or(0, |minute| minute as i64)
        };
        if !rest.is_empty() {
            return Err(invalid());
        }
        let offset = zone_hour as i64 * 60 + zone_minute;
        // RFC 3339 offsets allow minutes 00-59 and hours 00-23 (TS rejects
        // `+00:60` so it cannot shift by an hour).
        if offset >= 24 * 60 || zone_minute >= 60 {
            return Err(invalid());
        }
        offset_minutes = Some(sign * offset);
    }
    let Some(days) = days_from_civil(year, month, day) else {
        return Err(invalid());
    };
    let base_ms = days * 86_400_000
        + hour.map_or(0, |h| h as i64 * 3_600_000)
        + minute.map_or(0, |m| m as i64 * 60_000)
        + second as i64 * 1_000
        + millis;
    // The date must round-trip: `2026-02-31` is not a day, and an hour or
    // minute that rolls over (`25:00`) mismatches on the way back.
    let (check_year, check_month, check_day, check_hour, check_minute, _) = utc_parts(base_ms);
    if check_year != year
        || check_month != month
        || check_day != day
        || hour.is_some_and(|h| check_hour != h)
        || minute.is_some_and(|m| check_minute != m)
    {
        return Err(invalid());
    }
    Ok(base_ms - offset_minutes.unwrap_or(0) * 60_000)
}

/// Parse exactly `len` ASCII digits.
fn digits(text: &str) -> Option<u32> {
    if text.len() != 2 || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// Take exactly `len` ASCII digits off the front of `rest`.
fn take_digits(rest: &mut &str, len: usize) -> Option<u32> {
    let bytes = rest.as_bytes();
    if bytes.len() < len || !bytes[..len].iter().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let value = rest[..len].parse().ok()?;
    *rest = &rest[len..];
    Some(value)
}

/// `(year, month, day, hour, minute, second)` of an epoch-milliseconds
/// instant, UTC.
fn utc_parts(ms: EpochMs) -> (i64, u32, u32, u32, u32, u32) {
    let days = ms.div_euclid(86_400_000);
    let secs_of_day = ms.rem_euclid(86_400_000) / 1_000;
    let (year, month, day) = civil_from_days(days);
    (
        year,
        month,
        day,
        (secs_of_day / 3_600) as u32,
        (secs_of_day / 60 % 60) as u32,
        (secs_of_day % 60) as u32,
    )
}

/// `MM-DD HH:MM:SS` of the instant, UTC (TS `formatIncidentTime`).
pub(crate) fn format_incident_time(ms: EpochMs) -> String {
    let (_, month, day, hour, minute, second) = utc_parts(ms);
    format!("{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}")
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's
/// `days_from_civil`); `None` outside the supported year range.
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

#[cfg(test)]
mod tests {
    use super::*;

    /// `new Date("2026-09-16T22:30:00Z")`.
    const NOW: i64 = 1_789_597_800_000; // 2026-09-16T22:30:00Z

    fn date_ms(text: &str) -> i64 {
        pa_types::incident::timestamp_to_ms(text).expect("the fixture date parses")
    }

    #[test]
    fn parses_iso_datetimes_dates_and_bare_times_as_utc() {
        assert_eq!(
            parse_incident_time_bound("2026-09-16T20:02", NOW, "--since").expect("bound"),
            date_ms("2026-09-16T20:02:00.000Z")
        );
        assert_eq!(
            parse_incident_time_bound("2026-09-16", NOW, "--since").expect("bound"),
            date_ms("2026-09-16T00:00:00.000Z")
        );
        // "20:02" reads as today (2026-09-16) at 20:02 UTC.
        assert_eq!(
            parse_incident_time_bound("20:02", NOW, "--since").expect("bound"),
            date_ms("2026-09-16T20:02:00.000Z")
        );
        assert_eq!(
            parse_incident_time_bound("2026-09-16T20:02:53Z", NOW, "--since").expect("bound"),
            date_ms("2026-09-16T20:02:53.000Z")
        );
        assert_eq!(
            parse_incident_time_bound("2026-09-16T22:02+02:00", NOW, "--since").expect("bound"),
            date_ms("2026-09-16T20:02:00.000Z")
        );
    }

    #[test]
    fn accepts_fractional_seconds_pasted_from_the_log() {
        assert_eq!(
            parse_incident_time_bound("2026-09-16T20:02:39.764Z", NOW, "--since").expect("bound"),
            date_ms("2026-09-16T20:02:39.764Z")
        );
        assert_eq!(
            parse_incident_time_bound("2026-09-16T20:02:39.764", NOW, "--since").expect("bound"),
            date_ms("2026-09-16T20:02:39.764Z")
        );
        assert_eq!(
            parse_incident_time_bound("2026-09-16T20:02:39.7", NOW, "--since").expect("bound"),
            date_ms("2026-09-16T20:02:39.700Z")
        );
    }

    #[test]
    fn rejects_invalid_offset_minutes() {
        // RFC 3339 offsets allow minutes 00-59 only; +00:60 must not shift
        // by an hour.
        for garbage in [
            "2026-09-16T20:02+00:60",
            "2026-09-16T20:02-05:90",
            "2026-09-16T20:02+24:00",
        ] {
            assert!(
                parse_incident_time_bound(garbage, NOW, "--since").is_err(),
                "{garbage}"
            );
        }
        assert_eq!(
            parse_incident_time_bound("2026-09-16T20:02+05:45", NOW, "--since").expect("bound"),
            date_ms("2026-09-16T14:17:00.000Z")
        );
        // A zone-less offset without minutes (`+05`) is a legal hour
        // offset (TS `digits.slice(2) || 0`).
        assert_eq!(
            parse_incident_time_bound("2026-09-16T20:02+05", NOW, "--since").expect("bound"),
            date_ms("2026-09-16T15:02:00.000Z")
        );
    }

    #[test]
    fn rejects_garbage_and_impossible_dates_with_a_clear_usage_error() {
        for garbage in [
            "yesterday",
            "2026-13-01",
            "2026-09-32",
            "25:00",
            "2026-09-16T",
            "2026-02-31",
            "2026-09-16T25:00",
            "2026-09-16T20:99",
            "",
            "   ",
        ] {
            assert!(
                parse_incident_time_bound(garbage, NOW, "--since").is_err(),
                "{garbage}"
            );
        }
        let error = parse_incident_time_bound("garbage", NOW, "--since").unwrap_err();
        assert!(error.to_string().contains("--since"), "{error}");
        assert!(error.to_string().contains("20:02"), "{error}");
        // An empty value names the flag.
        let empty = parse_incident_time_bound("", NOW, "--until").unwrap_err();
        assert_eq!(empty.to_string(), "--until requires a time.");
    }

    #[test]
    fn formats_the_utc_stamp() {
        assert_eq!(
            format_incident_time(date_ms("2026-09-10T20:02:30.000Z")),
            "09-10 20:02:30"
        );
        assert_eq!(
            format_incident_time(date_ms("2026-01-01T00:00:00.000Z")),
            "01-01 00:00:00"
        );
    }
}
