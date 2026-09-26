//! The terminal status report (TS `buildDaemonUpdateRestartReport` port): the
//! user-facing lines the invoking CLI prints from a terminal status - the
//! `failures[]` detail, the restore counts, and the failure warning.

use pa_types::daemon::update_flow::{UpdateState, UpdateStatus};

/// The printed report: informational lines and warnings.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct UpdateReport {
    pub info: Vec<String>,
    pub warnings: Vec<String>,
}

impl UpdateReport {
    /// The TS report rules, kept verbatim: a `failed` status warns even
    /// before the counts; `complete` reports restored/resumed/failed counts
    /// and every per-session failure.
    pub fn build(status: &UpdateStatus) -> Self {
        let mut report = Self::default();
        if status.state == UpdateState::Failed {
            report.warnings.push(format!(
                "Updated, but could not restart the daemon ({}).",
                status.message.as_deref().unwrap_or("unknown error")
            ));
        }
        if status.state != UpdateState::Complete && status.state != UpdateState::Failed {
            return report;
        }
        if status.counts.total > 0 {
            report.info.push(format!(
                "Restored {} daemon session{}",
                status.counts.restored,
                plural(status.counts.restored)
            ));
        }
        if status.counts.resumed > 0 {
            report.info.push(format!(
                "Resumed {} interrupted session{}",
                status.counts.resumed,
                plural(status.counts.resumed)
            ));
        }
        if status.counts.failed > 0 {
            report.warnings.push(format!(
                "{} daemon session{} could not be restored.",
                status.counts.failed,
                plural(status.counts.failed)
            ));
        }
        for failure in &status.failures {
            report.warnings.push(format!(
                "Could not restore {}: {}",
                failure.session_file, failure.message
            ));
        }
        report
    }

    /// Print to stdout/stderr the way the CLI reports commands.
    pub fn print(&self) {
        for line in &self.info {
            println!("{line}");
        }
        for line in &self.warnings {
            eprintln!("{line}");
        }
    }
}

fn plural(count: u64) -> &'static str {
    if count == 1 {
        ""
    } else {
        "s"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pa_types::daemon::update_flow::{UpdateId, UpdateStatusCounts, UpdateStatusFailure};

    fn status(state: UpdateState, counts: UpdateStatusCounts) -> UpdateStatus {
        UpdateStatus {
            version: 1,
            update_id: UpdateId::from("u".to_string()),
            socket_path: "/s".to_string(),
            state,
            epoch: 2,
            coordinator: None,
            predecessor: None,
            successor: None,
            counts,
            failures: Vec::new(),
            message: None,
            started_at: "a".to_string(),
            updated_at: "b".to_string(),
            heartbeat_at: None,
            rest: serde_json::Map::default(),
        }
    }

    #[test]
    fn builds_the_ts_report_lines() {
        let counts = UpdateStatusCounts {
            total: 3,
            restored: 2,
            resumed: 1,
            failed: 1,
        };
        let mut complete = status(UpdateState::Complete, counts);
        complete.failures = vec![UpdateStatusFailure {
            session_file: "/sessions/a.jsonl".to_string(),
            message: "worker refused".to_string(),
        }];
        let report = UpdateReport::build(&complete);
        assert_eq!(
            report.info,
            vec![
                "Restored 2 daemon sessions",
                "Resumed 1 interrupted session"
            ]
        );
        assert_eq!(
            report.warnings,
            vec![
                "1 daemon session could not be restored.",
                "Could not restore /sessions/a.jsonl: worker refused",
            ]
        );
    }

    #[test]
    fn failed_warns_before_counts_and_nonterminal_reports_empty() {
        let mut failed = status(UpdateState::Failed, UpdateStatusCounts::default());
        failed.message = Some("boot timed out".to_string());
        let report = UpdateReport::build(&failed);
        assert_eq!(
            report.warnings,
            vec!["Updated, but could not restart the daemon (boot timed out)."]
        );
        let running =
            UpdateReport::build(&status(UpdateState::Booting, UpdateStatusCounts::default()));
        assert_eq!(running, UpdateReport::default());
    }
}
