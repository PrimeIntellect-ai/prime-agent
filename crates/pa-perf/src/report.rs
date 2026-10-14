//! The baseline comparison: the aggregate table (median, p95, baseline,
//! delta) and the >2x regression gate (report-only scenarios always print
//! deltas and never fail).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::bench::{BenchResult, Scenario};
use crate::corpus::Profile;

/// The committed baseline: one entry per scenario/profile key.
#[derive(Debug, Serialize, Deserialize)]
pub struct Baseline {
    pub schema: u32,
    /// "scenario/profile" -> the measured baseline.
    pub entries: BTreeMap<String, BaselineEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BaselineEntry {
    /// The baseline median (ms).
    pub median_ms: f64,
    /// Noisy scenarios (>20% spread across 3 CI runs): deltas print, the
    /// gate never fails.
    #[serde(default)]
    pub report_only: bool,
    /// Where the number came from (a CI run URL).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// The regression gate's ceiling: a median must stay under baseline * 2.
const REGRESSION_FACTOR: f64 = 2.0;

/// The comparison outcome: the markdown table and the failing rows.
#[derive(Debug)]
pub struct Report {
    pub markdown: String,
    pub regressions: Vec<String>,
}

/// Compare results against the baseline; the key is scenario/profile (the
/// serde names — one source for the wire, the CLI, and the keys).
#[must_use]
pub fn report(results: &[BenchResult], baseline: &Baseline) -> Report {
    let mut rows = Vec::new();
    let mut regressions = Vec::new();
    for result in results {
        let key = format!("{}/{}", key_of(result.scenario), result.profile);
        let median = result.median_ms;
        let Some(entry) = baseline.entries.get(&key) else {
            rows.push(format!(
                "| {} | {median:.1} | {:.1} | — | — | (no baseline) |",
                key, result.p95_ms
            ));
            continue;
        };
        let delta = median / entry.median_ms - 1.0;
        let verdict = if entry.report_only {
            "report-only".to_string()
        } else if median > entry.median_ms * REGRESSION_FACTOR {
            regressions.push(key.clone());
            "REGRESSION".to_string()
        } else {
            format!("{:+.0}%", delta * 100.0)
        };
        rows.push(format!(
            "| {} | {median:.1} | {:.1} | {:.1} | {:+.0}% | {verdict} |",
            key,
            result.p95_ms,
            entry.median_ms,
            delta * 100.0
        ));
    }
    let markdown = format!(
        "| scenario/profile | median ms | p95 ms | baseline ms | delta | verdict |\n|---|---|---|---|---|---|\n{}",
        rows.join("\n")
    );
    Report {
        markdown,
        regressions,
    }
}

/// The serde name of a scenario (the baseline key's scenario half — the
/// same name the CLI and the wire use).
#[must_use]
pub fn key_of(scenario: Scenario) -> String {
    serde_json::to_value(scenario)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// The serde name of a profile (the baseline key's profile half).
#[must_use]
pub fn profile_key(profile: Profile) -> String {
    serde_json::to_value(profile)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// The serde name of a cache mode (display only).
#[must_use]
pub fn profile_key_cache(mode: crate::corpus::CacheMode) -> String {
    serde_json::to_value(mode)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default()
}
