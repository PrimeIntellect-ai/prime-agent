//! The baseline comparison: the aggregate table (median, p95, baseline,
//! delta) and the >2x regression gate (report-only scenarios always print
//! deltas and never fail).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::bench::BenchResult;

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

/// Compare results against the baseline; the key is scenario/profile.
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
        } else if delta >= 0.0 {
            format!("+{delta:.0}%")
        } else {
            format!("{delta:.0}%")
        };
        rows.push(format!(
            "| {} | {median:.1} | {:.1} | {:.1} | {delta:+.0}% | {verdict} |",
            key, result.p95_ms, entry.median_ms
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

/// The scenario half of the baseline key.
#[must_use]
pub fn key_of(scenario: crate::bench::Scenario) -> String {
    match scenario {
        crate::bench::Scenario::ColdStart => "cold-start".to_string(),
        crate::bench::Scenario::WarmStart => "warm-start".to_string(),
        crate::bench::Scenario::AgentsView => "agents-view".to_string(),
        crate::bench::Scenario::AgentsViewWarm => "agents-view-warm".to_string(),
        crate::bench::Scenario::OpenSession => "open-session".to_string(),
        crate::bench::Scenario::SessionSwitch => "session-switch".to_string(),
        crate::bench::Scenario::AtCompletion => "at-completion".to_string(),
    }
}
