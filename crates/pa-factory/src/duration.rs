//! Durations written as words: `90s`, `30m`, `6h`, `1d`, `1h30m`.

use std::fmt::Write as _;

const UNITS: [(char, u64); 4] = [
    ('d', 86_400_000),
    ('h', 3_600_000),
    ('m', 60_000),
    ('s', 1_000),
];

/// Parse a duration into milliseconds.
///
/// # Errors
/// Returns the reason the text is not a positive duration.
pub fn parse_duration_ms(text: &str) -> Result<u64, String> {
    let invalid = || format!("{text:?} is not a duration: write it like 90s, 30m, 6h, 1d or 1h30m");
    let mut total: u64 = 0;
    let mut digits = String::new();
    let mut last_rank = None;
    for c in text.trim().chars() {
        if c.is_ascii_digit() {
            digits.push(c);
            continue;
        }
        let rank = UNITS
            .iter()
            .position(|(unit, _)| *unit == c)
            .ok_or_else(invalid)?;
        if digits.is_empty() || last_rank.is_some_and(|last| rank <= last) {
            return Err(invalid());
        }
        let amount: u64 = digits.parse().map_err(|_| invalid())?;
        total = amount
            .checked_mul(UNITS[rank].1)
            .and_then(|ms| total.checked_add(ms))
            .ok_or_else(invalid)?;
        digits.clear();
        last_rank = Some(rank);
    }
    if !digits.is_empty() || last_rank.is_none() || total == 0 {
        return Err(invalid());
    }
    Ok(total)
}

/// Milliseconds back into words, the largest exact units first.
#[must_use]
pub fn format_duration_ms(ms: u64) -> Option<String> {
    if ms == 0 || !ms.is_multiple_of(1_000) {
        return None;
    }
    let mut rest = ms;
    let mut out = String::new();
    for (unit, size) in UNITS {
        if rest >= size {
            let _ = write!(out, "{}{unit}", rest / size);
            rest %= size;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_formats() {
        assert_eq!(parse_duration_ms("1h30m"), Ok(5_400_000));
        assert_eq!(parse_duration_ms("90s"), Ok(90_000));
        assert_eq!(format_duration_ms(5_400_000).as_deref(), Some("1h30m"));
        assert_eq!(format_duration_ms(900_000).as_deref(), Some("15m"));
        assert_eq!(format_duration_ms(1_500), None);
        for bad in ["", "30", "m", "30m1h", "0s", "1.5h", "30 minutes"] {
            assert!(parse_duration_ms(bad).is_err(), "{bad}");
        }
    }
}
