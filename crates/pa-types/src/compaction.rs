//! Shared vocabulary for the automatic compaction percentage setting.

/// Whether a configured automatic compaction percentage is a finite value in 1–100.
#[must_use]
pub fn is_valid_threshold_percent(percent: f64) -> bool {
    percent.is_finite() && (1.0..=100.0).contains(&percent)
}
