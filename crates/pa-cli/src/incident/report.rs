//! The incident timeline report (TS `buildIncidentReport` and its
//! aggregation/rendering helpers).

use pa_types::incident::{
    collect_incident_events, collect_worker_pid_map, compute_incident_anomalies,
    format_incident_duration, IncidentCategory, IncidentEvent, IncidentLogEntry, IncidentSeverity,
};
use std::collections::HashMap;
use std::io::IsTerminal as _;

use super::time::format_incident_time;

/// The resolved window and filters of one report (TS
/// `IncidentReportOptions`).
#[derive(Debug, Clone, Default)]
pub(crate) struct IncidentReportOptions {
    pub(crate) since_ms: i64,
    pub(crate) until_ms: i64,
    pub(crate) session: Option<String>,
    pub(crate) source: Option<String>,
    pub(crate) scanned_count: Option<usize>,
    pub(crate) skipped_count: Option<usize>,
}

/// One rendered report (TS `IncidentReport`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IncidentReport {
    pub(crate) text: String,
}

/// TS `colorizeSeverity` rides chalk (auto-disabled off-TTY and under
/// `NO_COLOR`); the palette matches the TS: red for critical/error,
/// yellow for warn, dim for info.
fn colorize_severity(severity: IncidentSeverity, label: &str) -> String {
    match severity {
        IncidentSeverity::Critical | IncidentSeverity::Error => paint("31", label),
        IncidentSeverity::Warn => paint("33", label),
        IncidentSeverity::Info => paint("2", label),
    }
}

/// `chalk.dim`.
fn dim(text: &str) -> String {
    paint("2", text)
}

/// The ANSI wrapper honoring chalk's enable rule (TTY + no `NO_COLOR`),
/// with chalk's reset codes (bold/dim close with 22, colors with 39).
fn paint(code: &str, text: &str) -> String {
    if use_color() {
        let reset = if code == "2" { "22" } else { "39" };
        format!("\x1b[{code}m{text}\x1b[{reset}m")
    } else {
        text.to_string()
    }
}

fn use_color() -> bool {
    std::env::var_os("NO_COLOR").is_none() && std::io::stdout().is_terminal()
}

/// One aggregated timeline row: identical events collapse to a count with
/// their first and last timestamps (TS `AggregatedEvent`).
struct AggregatedEvent {
    first: IncidentEvent,
    last: IncidentEvent,
    count: usize,
    /// The section-arrival index, breaking exact first-time ties the way
    /// the TS `Map` insertion order does.
    arrival: usize,
}

/// Group identical events (`category|subject|summary`), keeping the first
/// and last time and the repeat count, ordered by first timestamp (TS
/// `aggregateIncidentEvents`; the arrival order breaks exact-time ties
/// the way the TS `Map` insertion order does).
fn aggregate_incident_events(events: &[IncidentEvent]) -> Vec<AggregatedEvent> {
    let mut groups: HashMap<String, AggregatedEvent> = HashMap::new();
    let mut arrival = 0usize;
    for incident in events {
        arrival += 1;
        let key = format!(
            "{}|{}|{}",
            incident.category.as_str(),
            incident.subject,
            incident.summary
        );
        match groups.get_mut(&key) {
            Some(existing) => {
                existing.count += 1;
                if incident.time_ms > existing.last.time_ms {
                    existing.last = incident.clone();
                }
                if incident.time_ms < existing.first.time_ms {
                    existing.first = incident.clone();
                }
            }
            None => {
                groups.insert(
                    key,
                    AggregatedEvent {
                        first: incident.clone(),
                        last: incident.clone(),
                        count: 1,
                        arrival,
                    },
                );
            }
        }
    }
    let mut aggregated: Vec<AggregatedEvent> = groups.into_values().collect();
    aggregated.sort_by_key(|group| (group.first.time_ms, group.arrival));
    aggregated
}

/// True when the event names the session filter: session ids, worker ids,
/// and quoted session names prefix-match in both directions (TS
/// `sessionMatches`). An empty token (a missing session name) is a prefix
/// of every value and must not match every session filter.
fn session_matches(incident: &IncidentEvent, session: &str) -> bool {
    incident.tokens.iter().any(|token| {
        !token.is_empty() && (token.starts_with(session) || session.starts_with(token))
    })
}

/// Build the full incident timeline text for a window: classified events
/// are grouped into Supervisor events / Session anomalies / Recovery
/// sections, repeated identical events are aggregated with counts, and
/// per-subject stalls, error bursts, and event gaps are surfaced as
/// anomalies (TS `buildIncidentReport`).
pub(crate) fn build_incident_report(
    entries: &[IncidentLogEntry],
    options: &IncidentReportOptions,
) -> IncidentReport {
    let worker_pids = collect_worker_pid_map(entries);
    let all_events = collect_incident_events(entries, &worker_pids);
    let mut events: Vec<IncidentEvent> = all_events
        .iter()
        .filter(|incident| {
            incident.time_ms >= options.since_ms && incident.time_ms <= options.until_ms
        })
        .cloned()
        .collect();
    let mut filtered_session: Option<&str> = None;
    if let Some(session) = options.session.as_deref() {
        let matching: Vec<IncidentEvent> = events
            .iter()
            .filter(|incident| session_matches(incident, session))
            .cloned()
            .collect();
        if matching.is_empty() && !events.is_empty() {
            return IncidentReport {
                text: format!(
                    "No daemon events between {} and {} UTC reference session \"{session}\".",
                    format_incident_time(options.since_ms),
                    format_incident_time(options.until_ms)
                ),
            };
        }
        events = matching;
        filtered_session = Some(session);
    }
    let reportable: Vec<IncidentEvent> = events
        .iter()
        .filter(|incident| incident.category != IncidentCategory::Anomaly)
        .cloned()
        .collect();
    let anomalies = compute_incident_anomalies(&reportable);
    let mut timeline_events = events;
    timeline_events.extend(anomalies);

    let mut sections: Vec<Vec<String>> = Vec::new();
    for (title, category) in [
        ("Supervisor events", IncidentCategory::Supervisor),
        ("Session anomalies", IncidentCategory::Anomaly),
        ("Recovery", IncidentCategory::Recovery),
    ] {
        let section_events: Vec<IncidentEvent> = timeline_events
            .iter()
            .filter(|incident| incident.category == category)
            .cloned()
            .collect();
        let mut lines: Vec<String> = aggregate_incident_events(&section_events)
            .iter()
            .map(|group| {
                let suffix = if group.count > 1 {
                    format!(
                        " (x{}, until {})",
                        group.count,
                        format_incident_time(group.last.time_ms)
                    )
                } else {
                    String::new()
                };
                format!(
                    "  {}  {}  {}{}",
                    format_incident_time(group.first.time_ms),
                    colorize_severity(
                        group.first.severity,
                        &format!("{:<8}", group.first.severity)
                    ),
                    group.first.summary,
                    suffix
                )
            })
            .collect();
        if lines.is_empty() {
            lines.push(format!("  {}", dim("(none)")));
        }
        sections.push(vec![title.to_string()].into_iter().chain(lines).collect());
    }

    let mut header = vec!["Prime Agent incident timeline".to_string()];
    header.push(format!(
        "Window: {} → {} UTC ({})",
        format_incident_time(options.since_ms),
        format_incident_time(options.until_ms),
        format_incident_duration(options.until_ms - options.since_ms)
    ));
    if let Some(source) = options.source.as_deref() {
        let in_window = all_events
            .iter()
            .filter(|incident| {
                incident.time_ms >= options.since_ms && incident.time_ms <= options.until_ms
            })
            .count();
        let skipped = options.skipped_count.unwrap_or(0);
        let skipped_text = if skipped > 0 {
            format!(", {skipped} unreadable skipped")
        } else {
            String::new()
        };
        header.push(format!(
            "Source: {source} ({} lines scanned, {in_window} events in window{skipped_text})",
            options.scanned_count.unwrap_or(entries.len())
        ));
    }
    if let Some(session) = filtered_session {
        header.push(format!("Session filter: {session}"));
    }

    // `[...header, "", ...sections.flatMap(section => [section.title,
    // ...section.lines, ""])]` joined and trimmed.
    let mut lines = header;
    lines.push(String::new());
    for section in &sections {
        lines.extend(section.iter().cloned());
        lines.push(String::new());
    }
    let text = lines.join("\n").trim_end().to_string();
    IncidentReport { text }
}

#[cfg(test)]
#[path = "report_tests.rs"]
mod tests;
