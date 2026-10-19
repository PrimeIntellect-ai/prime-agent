//! The corpus PRNG: a tiny deterministic splitmix64 (no external dependency).
//! The same seed produces a byte-identical corpus tree, file mtimes included.

/// A deterministic splitmix64 stream for corpus generation.
#[derive(Debug, Clone)]
pub(crate) struct Rng(u64);

impl Rng {
    /// A stream from `seed`.
    pub(crate) const fn new(seed: u64) -> Self {
        Self(seed)
    }

    /// The next raw value.
    pub(crate) fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// A uniform value below `bound` (an empty bound answers 0).
    pub(crate) fn below(&mut self, bound: u64) -> u64 {
        if bound == 0 {
            return 0;
        }
        self.next_u64() % bound
    }

    /// A true chance of `percent` in 100.
    pub(crate) fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }
}

/// Civil-date conversion (days since epoch -> y/m/d), the inverse of the
/// session parser's `civil_days`: keeps timestamp formatting allocation-free.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// ISO-8601 (UTC, millisecond precision) from unix milliseconds — the
/// product's entry-timestamp format.
#[must_use]
pub(crate) fn iso_from_millis(millis: u64) -> String {
    let secs = (millis / 1000) as i64;
    let rem = millis % 1000;
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{rem:03}Z")
}
