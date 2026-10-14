//! The report battery: the >2x regression gate, the report-only exempt,
//! and the missing-baseline row.

use std::collections::BTreeMap;

use pa_perf::bench::{BenchCorpus, BenchResult, Scenario};
use pa_perf::report::{report, Baseline, BaselineEntry};

fn result(scenario: Scenario, median_ms: f64) -> BenchResult {
    BenchResult {
        schema: 1,
        scenario,
        profile: "small".to_string(),
        runs: 10,
        samples_ms: vec![median_ms],
        median_ms,
        p95_ms: median_ms,
        needle: String::new(),
        binary: String::new(),
        corpus: BenchCorpus {
            root: std::path::PathBuf::new(),
            sessions: 10,
            total_rows: 3_500,
            child_sessions: 12,
            archive: 3,
        },
    }
}

fn baseline(median_ms: f64, report_only: bool) -> Baseline {
    Baseline {
        schema: 1,
        entries: BTreeMap::from([(
            "cold-start/small".to_string(),
            BaselineEntry {
                median_ms,
                report_only,
                source: None,
            },
        )]),
    }
}

#[test]
fn a_two_x_regression_fails_and_deltas_always_print() {
    let report = report(
        &[result(Scenario::ColdStart, 2_100.0)],
        &baseline(1_000.0, false),
    );
    assert_eq!(report.regressions, ["cold-start/small"]);
    assert!(report.markdown.contains("cold-start/small"));
    assert!(report.markdown.contains("REGRESSION"));
}

#[test]
fn a_report_only_row_never_fails_the_gate() {
    let report = report(
        &[result(Scenario::ColdStart, 5_000.0)],
        &baseline(1_000.0, true),
    );
    assert!(report.regressions.is_empty());
    assert!(report.markdown.contains("report-only"));
}

#[test]
fn a_missing_baseline_prints_no_baseline() {
    let report = report(
        &[result(Scenario::OpenSession, 147.0)],
        &baseline(1_000.0, false),
    );
    assert!(report.regressions.is_empty());
    assert!(report.markdown.contains("open-session/small"));
    assert!(report.markdown.contains("(no baseline)"));
}
