//! Anomaly computation from classified events (TS
//! `computeIncidentAnomalies` / `latestIncidentStallTimeoutBySubject`).

use super::{
    burst_classes, IncidentCategory, IncidentEvent, IncidentSeverity, ERROR_BURST_THRESHOLD,
    ERROR_BURST_WINDOW_MS, STALL_GAP_MS, TIMEOUT_STALL_WINDOW_MS,
};
use std::collections::HashMap;

/// Compact duration for spans and gaps (TS `formatIncidentDuration`):
/// seconds, then minutes+seconds, then hours+minutes.
pub fn format_incident_duration(ms: i64) -> String {
    // `Math.round(ms / 1000)` with at least one second (a zero-span gap
    // still reads as 1s, never 0s).
    let total_seconds = ((ms + 500) / 1000).max(1);
    let seconds = total_seconds % 60;
    let minutes = (total_seconds / 60) % 60;
    let hours = total_seconds / 3600;
    if hours > 0 {
        let minute_part = if minutes > 0 {
            format!("{minutes}m")
        } else {
            String::new()
        };
        format!("{hours}h{minute_part}")
    } else if minutes > 0 {
        let second_part = if seconds > 0 {
            format!("{seconds}s")
        } else {
            String::new()
        };
        format!("{minutes}m{second_part}")
    } else {
        format!("{seconds}s")
    }
}

/// The highest severity among the events (TS `maxSeverity`).
fn max_severity(events: &[IncidentEvent]) -> IncidentSeverity {
    events
        .iter()
        .map(|event| event.severity)
        .max_by_key(|severity| severity.rank())
        .unwrap_or(IncidentSeverity::Info)
}

/// The densest run of time-sorted events within `window_ms` of each other,
/// returned as the run's start index and length (TS `densestWindowRun`).
/// Shared by the stall and burst scans: only events close together form
/// one incident, so isolated events far apart never merge, whatever the
/// report window is.
fn densest_window_run(items: &[IncidentEvent], window_ms: i64) -> (usize, usize) {
    let mut best_start = 0;
    let mut best_count = 0;
    let mut start = 0;
    for end in 0..items.len() {
        while items[end].time_ms - items[start].time_ms > window_ms {
            start += 1;
        }
        let count = end - start + 1;
        if count > best_count {
            best_count = count;
            best_start = start;
        }
    }
    (best_start, best_count)
}

/// Compute stall, error-burst, and event-gap anomaly lines from classified
/// events (TS `computeIncidentAnomalies`).
pub fn compute_incident_anomalies(events: &[IncidentEvent]) -> Vec<IncidentEvent> {
    // Grouped in insertion order, like the TS `Map` iteration the
    // anomalies are pushed under.
    let mut by_subject: Vec<(String, Vec<IncidentEvent>)> = Vec::new();
    for incident in events
        .iter()
        .filter(|incident| incident.category != IncidentCategory::Anomaly)
    {
        match by_subject
            .iter_mut()
            .find(|(subject, _)| subject == &incident.subject)
        {
            Some((_, group)) => group.push(incident.clone()),
            None => by_subject.push((incident.subject.clone(), vec![incident.clone()])),
        }
    }

    let mut anomalies: Vec<IncidentEvent> = Vec::new();
    for (subject, group) in &by_subject {
        let mut group = group.clone();
        group.sort_by_key(|incident| incident.time_ms);
        let timeouts: Vec<IncidentEvent> = group
            .iter()
            .filter(|incident| incident.event_class == "timeout")
            .cloned()
            .collect();
        if timeouts.len() >= 2 {
            // Only timeouts within `TIMEOUT_STALL_WINDOW_MS` of each other
            // form a stall; two isolated timeouts hours apart in a long
            // window are not one.
            let (start, count) = densest_window_run(&timeouts, TIMEOUT_STALL_WINDOW_MS);
            if count >= 2 {
                let cluster = &timeouts[start..start + count];
                let span = cluster[cluster.len() - 1].time_ms - cluster[0].time_ms;
                anomalies.push(anomaly(
                    cluster[0].time_ms,
                    IncidentSeverity::Error,
                    subject,
                    format!(
                        "{subject}: {} command timeouts over {}",
                        cluster.len(),
                        format_incident_duration(span)
                    ),
                ));
            }
        }
        let burst: Vec<IncidentEvent> = group
            .iter()
            .filter(|incident| burst_classes().contains(incident.event_class.as_str()))
            .cloned()
            .collect();
        if burst.len() >= ERROR_BURST_THRESHOLD {
            // Only events within `ERROR_BURST_WINDOW_MS` of each other
            // form a burst; three isolated warnings days apart in a long
            // window are not one.
            let (start, count) = densest_window_run(&burst, ERROR_BURST_WINDOW_MS);
            if count >= ERROR_BURST_THRESHOLD {
                let cluster = &burst[start..start + count];
                let span = cluster[cluster.len() - 1].time_ms - cluster[0].time_ms;
                anomalies.push(anomaly(
                    cluster[0].time_ms,
                    max_severity(cluster),
                    subject,
                    format!(
                        "{subject}: {} warnings/errors over {}",
                        cluster.len(),
                        format_incident_duration(span)
                    ),
                ));
            }
        }
        if subject.starts_with("session ") {
            for window in group.windows(2) {
                let gap = window[1].time_ms - window[0].time_ms;
                if gap >= STALL_GAP_MS {
                    anomalies.push(anomaly(
                        window[0].time_ms,
                        IncidentSeverity::Warn,
                        subject,
                        format!(
                            "{subject}: {} event gap (no logged events)",
                            format_incident_duration(gap)
                        ),
                    ));
                }
            }
        }
    }
    anomalies.sort_by_key(|anomaly| anomaly.time_ms);
    anomalies
}

/// One synthesized anomaly line (TS `computeIncidentAnomalies`' local
/// `push`).
fn anomaly(
    time_ms: i64,
    severity: IncidentSeverity,
    subject: &str,
    summary: String,
) -> IncidentEvent {
    IncidentEvent {
        time_ms,
        severity,
        category: IncidentCategory::Anomaly,
        event_class: "anomaly".to_string(),
        subject: subject.to_string(),
        summary,
        tokens: Vec::new(),
    }
}

/// Per subject, the latest timeout of the stall cluster
/// [`compute_incident_anomalies`] reports — the densest run within
/// `TIMEOUT_STALL_WINDOW_MS` (TS `latestIncidentStallTimeoutBySubject`).
/// The agents-view notice anchors its dismissal horizon there, so the
/// notice, its horizon, and the reported cluster always describe the same
/// incident, even when the window holds several stalls on one subject.
pub fn latest_incident_stall_timeout_by_subject(events: &[IncidentEvent]) -> HashMap<String, i64> {
    // Grouped in insertion order, like the TS `Map` iteration below.
    let mut timeouts_by_subject: Vec<(String, Vec<IncidentEvent>)> = Vec::new();
    for incident in events
        .iter()
        .filter(|incident| incident.event_class == "timeout")
    {
        match timeouts_by_subject
            .iter_mut()
            .find(|(subject, _)| subject == &incident.subject)
        {
            Some((_, group)) => group.push(incident.clone()),
            None => timeouts_by_subject.push((incident.subject.clone(), vec![incident.clone()])),
        }
    }
    let mut latest_by_subject = HashMap::new();
    for (subject, timeouts) in &timeouts_by_subject {
        // Callers pass time-sorted events; sort defensively so the run
        // scan (which assumes ascending times) never sees them out of
        // order.
        let mut timeouts = timeouts.clone();
        timeouts.sort_by_key(|incident| incident.time_ms);
        let (start, count) = densest_window_run(&timeouts, TIMEOUT_STALL_WINDOW_MS);
        if count >= 2 {
            latest_by_subject.insert(subject.clone(), timeouts[start + count - 1].time_ms);
        }
    }
    latest_by_subject
}

#[cfg(test)]
mod tests {
    use super::*;

    fn timeout_event(subject: &str, time_ms: i64) -> IncidentEvent {
        IncidentEvent {
            time_ms,
            severity: IncidentSeverity::Error,
            category: IncidentCategory::Supervisor,
            event_class: "timeout".to_string(),
            subject: subject.to_string(),
            summary: format!("{subject} timeout"),
            tokens: Vec::new(),
        }
    }

    fn burst_event(subject: &str, time_ms: i64) -> IncidentEvent {
        IncidentEvent {
            time_ms,
            severity: IncidentSeverity::Warn,
            category: IncidentCategory::Supervisor,
            event_class: "command-failure".to_string(),
            subject: subject.to_string(),
            summary: format!("{subject} failure {time_ms}"),
            tokens: Vec::new(),
        }
    }

    #[test]
    fn duration_matches_the_ts_buckets() {
        assert_eq!(format_incident_duration(0), "1s");
        assert_eq!(format_incident_duration(999), "1s");
        assert_eq!(format_incident_duration(2_500), "3s");
        assert_eq!(format_incident_duration(120_000), "2m");
        assert_eq!(format_incident_duration(1_158_000), "19m18s");
        assert_eq!(format_incident_duration(607_000), "10m7s");
        assert_eq!(format_incident_duration(3_700_000), "1h1m40s");
        assert_eq!(format_incident_duration(86_400_000), "24h");
    }

    #[test]
    fn durations_in_anomalies_report_the_cluster_span() {
        let daemon_a = "/tmp/prime-agent-501/daemon.sock";
        let daemon_b = "/tmp/other/daemon.sock";
        let minute = 60_000;
        let base = 1_789_089_600_000; // 2026-09-10T20:00:00Z
        let events = vec![
            timeout_event(daemon_a, base + 2 * minute),
            timeout_event(daemon_a, base + 8 * minute),
            timeout_event(daemon_a, base + 9 * minute),
            timeout_event(daemon_a, base + 21 * minute),
            timeout_event(daemon_b, base + 3 * minute),
            timeout_event(daemon_b, base + 10 * minute),
            timeout_event(daemon_b, base + 30 * minute),
        ];
        let anomalies = compute_incident_anomalies(&events);
        let summaries: Vec<&str> = anomalies.iter().map(|a| a.summary.as_str()).collect();
        assert!(summaries
            .contains(&"/tmp/prime-agent-501/daemon.sock: 4 command timeouts over 19m" as &str));
        assert!(summaries.contains(&"/tmp/other/daemon.sock: 3 command timeouts over 27m" as &str));
        // The stall anchors at the cluster's first timeout.
        let daemon_a_stall = anomalies
            .iter()
            .find(|a| a.summary.starts_with(daemon_a))
            .expect("daemon A stall");
        assert_eq!(daemon_a_stall.time_ms, base + 2 * minute);
    }

    #[test]
    fn isolated_failures_days_apart_never_merge() {
        let base = 1_789_089_600_000; // 2026-09-10T20:00:00Z
        let day = 86_400_000;
        let subject = "/tmp/prime-agent-501/daemon.sock";
        let events = vec![
            burst_event(subject, base),
            burst_event(subject, base + 2 * day),
            burst_event(subject, base + 4 * day),
            timeout_event(subject, base),
            timeout_event(subject, base + 2 * day),
        ];
        let anomalies = compute_incident_anomalies(&events);
        assert!(anomalies
            .iter()
            .all(|anomaly| !anomaly.summary.contains("warnings/errors")));
        assert!(anomalies
            .iter()
            .all(|anomaly| !anomaly.summary.contains("command timeouts")));
    }

    #[test]
    fn bursts_of_command_failures_surface_as_warnings() {
        let base = 1_789_089_600_000; // 2026-09-10T20:00:00Z
        let events: Vec<IncidentEvent> = (1..=3)
            .map(|index| burst_event("/tmp/prime-agent-501/daemon.sock", base + index * 60_000))
            .collect();
        let anomalies = compute_incident_anomalies(&events);
        assert!(anomalies
            .iter()
            .any(|anomaly| anomaly.summary.contains("3 warnings/errors over 2m")));
    }

    #[test]
    fn long_gaps_between_session_events_are_flagged() {
        let base = 1_789_089_600_000; // 2026-09-10T20:00:00Z
        let minute = 60_000;
        let subject = "session aabbccddeeff";
        let events = vec![
            burst_event(subject, base),
            burst_event(subject, base + 5 * minute),
            burst_event(subject, base + 30 * minute),
        ];
        let anomalies = compute_incident_anomalies(&events);
        let gap = anomalies
            .iter()
            .find(|anomaly| anomaly.summary.contains("event gap"))
            .expect("the gap anomaly");
        assert_eq!(
            gap.summary,
            "session aabbccddeeff: 25m event gap (no logged events)"
        );
        assert_eq!(gap.severity, IncidentSeverity::Warn);
        assert_eq!(gap.time_ms, base + 5 * minute);
    }

    #[test]
    fn latest_stall_timeout_follows_the_densest_cluster() {
        // The TS notice fixture: timeouts 200/190/180 minutes ago form one
        // dense cluster (three events within 20m of each other), 30/29
        // minutes ago a separate pair; the stall describes the first
        // cluster and anchors at its LATEST timeout (180 minutes ago).
        let base = 1_789_089_600_000; // 2026-09-10T20:00:00Z
        let minute = 60_000;
        let spaced = "spaced";
        let events = vec![
            timeout_event(spaced, base - 200 * minute),
            timeout_event(spaced, base - 190 * minute),
            timeout_event(spaced, base - 180 * minute),
            timeout_event(spaced, base - 30 * minute),
            timeout_event(spaced, base - 29 * minute),
        ];
        let latest = latest_incident_stall_timeout_by_subject(&events);
        assert_eq!(latest.get(spaced), Some(&(base - 180 * minute)));
        let anomalies = compute_incident_anomalies(&events);
        let stall = anomalies
            .iter()
            .find(|anomaly| anomaly.summary.contains("command timeouts"))
            .expect("the stall anomaly");
        assert!(stall.summary.contains("3 command timeouts over 20m"));
    }
}
