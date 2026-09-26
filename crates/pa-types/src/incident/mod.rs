//! The daemon incident classifier, shared by the incident CLI (pa-cli,
//! TS `src/cli/incident.ts`) and the agents-view incident notices (pa-tui,
//! TS `src/modes/agents-view/incident-notices.ts`).
//!
//! The classifier reconstructs what the daemon did during a time window
//! from its diagnostic logs, so an operator does not have to grep hundreds
//! of raw log lines by hand. The primary source is the shared structured
//! log (`~/.prime/agent/logs/agent.jsonl`, one JSON object per line,
//! written by the `coding-agent.daemon-supervisor`, `coding-agent.daemon`,
//! and `ai.provider` components). When that file is missing or
//! unreadable, the incident CLI falls back to the newest per-daemon log
//! (`~/.prime/agent/logs/<socket>.<hash>.log`, plain-text lines).
//!
//! Message shapes below match the strings the supervisor and session
//! worker actually emit (the `DaemonSupervisor.log` / `DaemonMode.log`
//! call sites). Unknown warning lines fall through to a generic per-line
//! summary so new log messages degrade to a readable timeline instead of
//! disappearing.
//!
//! This module is the classifier only: log-file discovery, the `--since`
//! / `--until` window CLI parsing, and report rendering belong to pa-cli;
//! the notice polling, rotation-safe incremental reads, and dismissal
//! horizons belong to pa-tui's `incident_notices`.

mod anomaly;
mod classify;
mod parse;
mod patterns;

pub use anomaly::{
    compute_incident_anomalies, format_incident_duration, latest_incident_stall_timeout_by_subject,
};
pub use classify::{
    classify_incident_entry, collect_incident_events, collect_worker_pid_map,
    worker_id_from_socket_path, WorkerPidMap, WorkerPidSighting,
};
pub use parse::{parse_incident_daemon_log_line, parse_incident_log_line, timestamp_to_ms};

use std::collections::HashSet;

/// One severity band of a classified incident event (TS
/// `IncidentSeverity`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum IncidentSeverity {
    Critical,
    Error,
    Warn,
    Info,
}

impl IncidentSeverity {
    /// The lowercase wire word the TS type unions over.
    pub fn as_str(self) -> &'static str {
        match self {
            IncidentSeverity::Critical => "critical",
            IncidentSeverity::Error => "error",
            IncidentSeverity::Warn => "warn",
            IncidentSeverity::Info => "info",
        }
    }
}

impl IncidentSeverity {
    /// The severity ordering (TS `SEVERITY_RANK`: critical 3 > error 2 >
    /// warn 1 > info 0).
    pub fn rank(self) -> u8 {
        match self {
            IncidentSeverity::Critical => 3,
            IncidentSeverity::Error => 2,
            IncidentSeverity::Warn => 1,
            IncidentSeverity::Info => 0,
        }
    }
}

impl std::fmt::Display for IncidentSeverity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // `f.pad` (not `write_str`): the report pads the severity label to
        // 8 columns via `{:8}`, which a `write_str` impl ignores.
        f.pad(self.as_str())
    }
}

/// One section of the incident timeline (TS `IncidentCategory`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum IncidentCategory {
    Supervisor,
    Anomaly,
    Recovery,
}

impl IncidentCategory {
    /// The lowercase wire word the TS type unions over.
    pub fn as_str(self) -> &'static str {
        match self {
            IncidentCategory::Supervisor => "supervisor",
            IncidentCategory::Anomaly => "anomaly",
            IncidentCategory::Recovery => "recovery",
        }
    }
}

/// One parsed `agent.jsonl` record (TS `IncidentLogEntry`).
#[derive(Debug, Clone, PartialEq)]
pub struct IncidentLogEntry {
    pub time_ms: i64,
    pub level: String,
    pub component: String,
    pub msg: String,
    pub socket_path: Option<String>,
    pub pid: Option<i64>,
    /// The raw log record, used for provider failure details (kind/status).
    pub fields: crate::JsonMap,
}

/// One classified incident event (TS `IncidentEvent`).
#[derive(Debug, Clone, PartialEq)]
pub struct IncidentEvent {
    pub time_ms: i64,
    pub severity: IncidentSeverity,
    pub category: IncidentCategory,
    pub event_class: String,
    pub subject: String,
    pub summary: String,
    pub tokens: Vec<String>,
}

/// A command-timeout stall is repeated command timeouts close together,
/// like the burst window; timeouts further apart than this never merge
/// into one stall, whatever the report window is (TS
/// `TIMEOUT_STALL_WINDOW_MS`). The agents-view dismissal horizon derives
/// from the same bound via [`latest_incident_stall_timeout_by_subject`].
pub const TIMEOUT_STALL_WINDOW_MS: i64 = 30 * 60 * 1000;

/// A stall is also flagged as an event gap once this much time passes
/// between one session subject's events (TS `STALL_GAP_MS`).
pub(crate) const STALL_GAP_MS: i64 = 10 * 60 * 1000;

/// A burst is several warnings/errors close together (TS
/// `ERROR_BURST_THRESHOLD`); isolated failures far apart are not one
/// incident.
pub(crate) const ERROR_BURST_THRESHOLD: usize = 3;

/// Only events within this window of each other form a burst (TS
/// `ERROR_BURST_WINDOW_MS`); three isolated warnings days apart in a long
/// window are not one.
pub(crate) const ERROR_BURST_WINDOW_MS: i64 = 10 * 60 * 1000;

/// Per-line summary truncation bound (TS `SUMMARY_TRUNCATION`).
pub(crate) const SUMMARY_TRUNCATION: usize = 120;

/// Operation kinds shown in a recovery breakdown (TS
/// `RECOVERY_BREAKDOWN_LIMIT`).
pub(crate) const RECOVERY_BREAKDOWN_LIMIT: usize = 4;

/// Event classes whose repeats form an error burst (TS `BURST_CLASSES`).
pub(crate) fn burst_classes() -> &'static HashSet<&'static str> {
    static CLASSES: std::sync::LazyLock<HashSet<&'static str>> =
        std::sync::LazyLock::new(|| HashSet::from(["command-failure", "auth", "diagnostic"]));
    &CLASSES
}

/// Event classes the classifier dedupes across the structured log and the
/// worker stderr forward (TS `LIFECYCLE_CLASSES`).
pub(crate) fn lifecycle_classes() -> &'static HashSet<&'static str> {
    static CLASSES: std::sync::LazyLock<HashSet<&'static str>> = std::sync::LazyLock::new(|| {
        HashSet::from([
            "worker-start",
            "worker-stop",
            "worker-crash",
            "worker-passivation",
        ])
    });
    &CLASSES
}

/// The first line of a message, trimmed (TS `firstLine`).
pub(crate) fn first_line(text: &str) -> &str {
    text.split('\n').next().unwrap_or("").trim()
}

/// Truncate to `max` visible characters with an ellipsis (TS
/// `truncateText`).
pub(crate) fn truncate_text(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let cut: String = trimmed.chars().take(max).collect();
    format!("{cut}...")
}

/// Strip a leading `Error:` prefix and its whitespace (TS `errorMessage`
/// replaces `/^Error:\s*/`).
pub(crate) fn error_message(message: &str) -> &str {
    if let Some(rest) = message.strip_prefix("Error:") {
        rest.trim_start()
    } else {
        message
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_line_trims_the_tail() {
        assert_eq!(first_line("line one\nline two\n"), "line one");
        assert_eq!(first_line("  padded  "), "padded");
    }

    #[test]
    fn truncate_marks_the_cut() {
        assert_eq!(truncate_text("short", 10), "short");
        assert_eq!(truncate_text("  a long summary  ", 7), "a long ...");
    }

    #[test]
    fn error_prefix_strips_only_the_prefix() {
        assert_eq!(error_message("Error: boom"), "boom");
        assert_eq!(error_message("boom"), "boom");
    }
}
