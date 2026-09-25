//! Millisecond-epoch to ISO-8601 (UTC) formatting, no time crate.
//!
//! Telemetry timestamps are stored as epoch milliseconds and rendered as
//! `YYYY-MM-DDTHH:MM:SS.mmmZ` for the PostHog `timestamp` field and the local
//! JSONL mirror. Civil-date math per Howard Hinnant's `civil_from_days`.

/// Milliseconds since the Unix epoch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct EpochMs(pub u64);

impl EpochMs {
    /// Current wall-clock time.
    pub fn now() -> Self {
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        Self(millis)
    }

    /// ISO-8601 UTC with millisecond precision, e.g. `2026-09-17T12:34:56.789Z`.
    pub fn iso8601(self) -> String {
        let total_secs = self.0 / 1000;
        let millis = self.0 % 1000;
        let days = total_secs / 86_400;
        let secs_of_day = total_secs % 86_400;
        let (year, month, day) = civil_from_days(days as i64);
        let (hour, minute, second) = (
            secs_of_day / 3600,
            (secs_of_day / 60) % 60,
            secs_of_day % 60,
        );
        format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
    }
}

/// Days since 1970-01-01 to `(year, month, day)` (proleptic Gregorian).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    (year, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_zero() {
        assert_eq!(EpochMs(0).iso8601(), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn known_instants() {
        assert_eq!(
            EpochMs(1_790_700_705_951).iso8601(),
            "2026-09-29T16:51:45.951Z"
        );
        // 2100-01-01T00:00:00.000Z (century non-leap year)
        assert_eq!(
            EpochMs(4_102_444_800_000).iso8601(),
            "2100-01-01T00:00:00.000Z"
        );
        // 2000-02-29T12:00:00.500Z (leap day)
        assert_eq!(
            EpochMs(951_825_600_500).iso8601(),
            "2000-02-29T12:00:00.500Z"
        );
        // 1969-12-31 is out of range (unsigned); clamp boundary is the epoch itself.
        assert_eq!(EpochMs(86_399_999).iso8601(), "1970-01-01T23:59:59.999Z");
    }
}
