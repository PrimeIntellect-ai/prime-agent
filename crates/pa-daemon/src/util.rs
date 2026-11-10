//! Small shared helpers.

use std::time::{SystemTime, UNIX_EPOCH};

/// 12-char hex display id (port of `formatSessionDisplayId`): the last 12
/// hex characters of a random UUID.
#[must_use]
pub fn new_display_id() -> String {
    let normalized: String = uuid::Uuid::new_v4().simple().to_string().to_lowercase();
    normalized[(normalized.len() - 12)..].to_string()
}

/// Milliseconds since the Unix epoch.
#[must_use]
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// RFC 3339 / ISO 8601 UTC timestamp, matching `new Date().toISOString()`.
#[must_use]
pub fn now_iso() -> String {
    iso_from_unix_ms(now_ms())
}

/// RFC 3339 UTC timestamp from epoch milliseconds (no external time crate;
/// civil-from-days algorithm from Howard Hinnant, used by chrono).
#[must_use]
pub fn iso_from_unix_ms(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let millis = (ms % 1000) as u32;
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Epoch milliseconds from an RFC 3339 UTC timestamp (`YYYY-MM-DDTHH:MM:SS[.fff]Z`, the shape
/// `now_iso` writes and the TS product's `new Date().toISOString()`). `None` for anything else.
pub fn iso_to_unix_ms(iso: &str) -> Option<u64> {
    let bytes = iso.as_bytes();
    if bytes.len() < 19
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || (bytes[10] != b'T' && bytes[10] != b' ')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let year: i64 = iso.get(0..4)?.parse().ok()?;
    let month = iso.get(5..7)?.parse::<u32>().ok()?;
    let day = iso.get(8..10)?.parse::<u32>().ok()?;
    let hour = iso.get(11..13)?.parse::<u32>().ok()?;
    let minute = iso.get(14..16)?.parse::<u32>().ok()?;
    let second = iso.get(17..19)?.parse::<u32>().ok()?;
    let millis: u64 = if bytes.len() > 20 && bytes[19] == b'.' {
        let digits: String = iso[20..].chars().take_while(char::is_ascii_digit).collect();
        if digits.is_empty() {
            return None;
        }
        let mut scaled = [b'0'; 3];
        for (slot, digit) in scaled.iter_mut().zip(digits.as_bytes()) {
            *slot = *digit;
        }
        String::from_utf8(scaled.to_vec()).ok()?.parse().ok()?
    } else {
        0
    };
    if !(1..=12).contains(&month) || day == 0 || day > 31 || hour > 23 || minute > 59 || second > 59
    {
        return None;
    }
    // Impossible calendar dates (2026-02-31) read as undatable: the day
    // count would normalize such a day into the next month, fabricating a
    // timestamp that never existed (TS `Date.parse` rejects them too).
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        _ => 28,
    };
    if day > days_in_month {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + i64::from(hour) * 3_600 + i64::from(minute) * 60 + i64::from(second);

    if secs < 0 {
        return None;
    }
    Some((secs * 1000 + millis as i64) as u64)
}

/// Parse one RFC 3339 timestamp into nanoseconds since the epoch: the
/// grammar `YYYY-MM-DD[Tt]HH:MM:SS[.frac](Z|z|±HH:MM)` — the offset
/// applied (the instant is preserved), one to nine fractional digits,
/// the calendar validated (an impossible date such as February 31st
/// reads as undatable, exactly like the ISO 8601 parser the settings
/// and daemon surfaces share), and trailing garbage rejected. The
/// `google.protobuf.Timestamp` JSON string form — the A2A surface's
/// `statusTimestampAfter` (spec 3.1.4) — is exactly this grammar.
#[must_use]
pub(crate) fn rfc3339_to_unix_ns(text: &str) -> Option<i128> {
    let bytes = text.as_bytes();
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || (bytes[10] != b'T' && bytes[10] != b't')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let year: i64 = text.get(0..4)?.parse().ok()?;
    let month = text.get(5..7)?.parse::<u32>().ok()?;
    let day = text.get(8..10)?.parse::<u32>().ok()?;
    let hour = text.get(11..13)?.parse::<u32>().ok()?;
    let minute = text.get(14..16)?.parse::<u32>().ok()?;
    let second = text.get(17..19)?.parse::<u32>().ok()?;
    let mut rest = &text[19..];
    let mut fraction_nanos: i128 = 0;
    if rest.as_bytes().first() == Some(&b'.') {
        // The ProtoJSON timestamp allows at most nine fractional
        // digits; more is invalid syntax, never a truncated instant.
        let digits: String = rest[1..].chars().take_while(char::is_ascii_digit).collect();
        if digits.is_empty() || digits.len() > 9 {
            return None;
        }
        let mut scaled = String::with_capacity(9);
        scaled.push_str(&digits);
        while scaled.len() < 9 {
            scaled.push('0');
        }
        fraction_nanos = scaled.parse::<i128>().ok()?;
        rest = &rest[1 + digits.len()..];
    }
    let offset_secs: i64 = match rest.as_bytes().first()? {
        b'Z' | b'z' if rest.len() == 1 => 0,
        sign @ (b'+' | b'-') if rest.len() == 6 => {
            let offset_hour = rest.get(1..3)?.parse::<i64>().ok()?;
            let offset_minute = rest.get(4..6)?.parse::<i64>().ok()?;
            if rest.as_bytes()[3] != b':' || offset_hour > 23 || offset_minute > 59 {
                return None;
            }
            let magnitude = offset_hour * 3_600 + offset_minute * 60;
            if *sign == b'+' {
                magnitude
            } else {
                -magnitude
            }
        }
        _ => return None,
    };
    if !(1..=12).contains(&month) || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        _ => 28,
    };
    if day == 0 || day > days_in_month {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + i64::from(hour) * 3_600 + i64::from(minute) * 60 + i64::from(second);
    Some(i128::from(secs - offset_secs) * 1_000_000_000 + fraction_nanos)
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + i64::from(doy);
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_matches_known_dates() {
        assert_eq!(iso_from_unix_ms(0), "1970-01-01T00:00:00.000Z");
        // 2026-09-16T00:00:00Z = 1789555200
        assert_eq!(
            iso_from_unix_ms(1_789_516_800_000),
            "2026-09-16T00:00:00.000Z"
        );
        // Leap-day boundary: 2024-02-29T23:59:59.999Z = 1709251199
        assert_eq!(
            iso_from_unix_ms(1_709_251_199_999),
            "2024-02-29T23:59:59.999Z"
        );
    }

    #[test]
    fn iso_rejects_impossible_calendar_dates() {
        assert_eq!(iso_to_unix_ms("2026-02-31T00:00:00Z"), None);
        assert_eq!(iso_to_unix_ms("2023-02-29T00:00:00Z"), None);
        assert_eq!(iso_to_unix_ms("2026-04-31T00:00:00Z"), None);
        // A real leap day still parses: 2024-02-29T00:00:00Z = 1709164800.
        assert_eq!(
            iso_to_unix_ms("2024-02-29T00:00:00Z"),
            Some(1_709_164_800_000)
        );
    }

    #[test]
    fn rfc3339_preserves_the_instant_and_the_precision() {
        // 2026-11-06T10:29:28Z = 1_793_960_968.
        let utc = rfc3339_to_unix_ns("2026-11-06T10:29:28Z").expect("parses");
        assert_eq!(utc, 1_793_960_968_000_000_000);
        // The same instant with a one-hour offset subtracted reads back
        // identically: the offset applies, never the literal clock.
        assert_eq!(rfc3339_to_unix_ns("2026-11-06T11:29:28+01:00"), Some(utc));
        assert_eq!(rfc3339_to_unix_ns("2026-11-06T05:29:28-05:00"), Some(utc));
        // Sub-millisecond precision survives to the nanosecond.
        let with_millis = rfc3339_to_unix_ns("2026-11-06T10:29:28.669Z").expect("parses");
        assert_eq!(with_millis, utc + 669_000_000);
        assert_eq!(
            rfc3339_to_unix_ns("2026-11-06T10:29:28.669000001Z"),
            Some(utc + 669_000_001)
        );
        // A negative offset can land exactly on the epoch (the filter
        // compares instants, it does not clamp them).
        assert_eq!(rfc3339_to_unix_ns("1969-12-31T23:00:00-01:00"), Some(0));
    }

    #[test]
    fn rfc3339_rejects_invalid_syntax() {
        // Trailing garbage, an empty fraction, over-precision, a
        // missing offset, and the ISO-8601 space separator are all
        // parameter errors, never silently accepted instants.
        assert_eq!(rfc3339_to_unix_ns("1970-01-01T00:00:00GARBAGE"), None);
        assert_eq!(rfc3339_to_unix_ns("1970-01-01T00:00:00."), None);
        assert_eq!(rfc3339_to_unix_ns("1970-01-01T00:00:00.1234567890Z"), None);
        assert_eq!(rfc3339_to_unix_ns("1970-01-01T00:00:00"), None);
        assert_eq!(rfc3339_to_unix_ns("1970-01-01 00:00:00Z"), None);
        // Impossible calendar dates read as undatable.
        assert_eq!(rfc3339_to_unix_ns("2026-02-31T00:00:00Z"), None);
        // A leap second is not a ProtoJSON timestamp instant.
        assert_eq!(rfc3339_to_unix_ns("2026-12-31T23:59:60Z"), None);
        // An impossible offset is rejected too.
        assert_eq!(rfc3339_to_unix_ns("1970-01-01T00:00:00+24:00"), None);
    }
}
