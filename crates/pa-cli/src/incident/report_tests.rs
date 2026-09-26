//! Report tests (the TS `incident.test.ts` report/window/session-filter
//! suites, asserted on plain text like the TS `stripAnsi` comparisons).

use super::*;
use pa_types::incident::parse_incident_log_line;
use serde_json::json;

const SINCE_MS: i64 = 1_789_070_400_000; // 2026-09-10T20:00:00Z
const UNTIL_MS: i64 = 1_789_072_200_000; // 2026-09-10T20:30:00Z

fn entries(lines: &[String]) -> Vec<IncidentLogEntry> {
    lines
        .iter()
        .filter_map(|line| parse_incident_log_line(line))
        .collect()
}

/// A supervisor-side log line (the daemon-supervisor component).
fn supervisor_line(ts: &str, msg: &str, extra: serde_json::Value) -> String {
    let mut record = json!({
        "ts": ts,
        "level": "warn",
        "component": "coding-agent.daemon-supervisor",
        "msg": msg,
        "pid": 15026,
        "socketPath": "/tmp/prime-agent-501/daemon.sock",
    });
    if let (Some(fields), Some(record)) = (extra.as_object(), record.as_object_mut()) {
        for (key, value) in fields {
            record.insert(key.clone(), value.clone());
        }
    }
    record.to_string()
}

/// A worker daemon log line for the fixture pid.
fn daemon_line(ts: &str, socket_path: &str, msg: &str) -> String {
    json!({
        "ts": ts,
        "level": "warn",
        "component": "coding-agent.daemon",
        "socketPath": socket_path,
        "pid": 53615,
        "msg": msg,
    })
    .to_string()
}

/// A worker daemon startup line, the pid sighting that anchors attribution.
fn worker_start_line(ts: &str, socket_path: &str, pid: i64) -> String {
    json!({
        "ts": ts,
        "level": "warn",
        "component": "coding-agent.daemon",
        "socketPath": socket_path,
        "pid": pid,
        "msg": format!("Prime Agent daemon listening on {socket_path}"),
    })
    .to_string()
}

fn report_for(lines: &[String]) -> String {
    report_for_with(lines, &default_options())
}

fn report_for_with(lines: &[String], options: &IncidentReportOptions) -> String {
    build_incident_report(&entries(lines), options).text
}

fn default_options() -> IncidentReportOptions {
    IncidentReportOptions {
        since_ms: SINCE_MS,
        until_ms: UNTIL_MS,
        ..Default::default()
    }
}

/// The 2026-09-10 crash + recovery fixture: attach timeouts 20:02-20:21,
/// the EPIPE crash, and the recovery holding backlogged operations.
fn incident_fixture_lines() -> Vec<String> {
    let supervisor = |ts: &str, msg: &str| {
        json!({
            "ts": ts,
            "component": "coding-agent.daemon-supervisor",
            "socketPath": "/tmp/prime-agent-501/daemon.sock",
            "pid": 15026,
            "msg": msg,
        })
        .to_string()
    };
    let crashed_worker = "/tmp/prime-agent-501/worker-98ed5cb228d2-5b1d3aeb91ee.sock";
    let mut lines = Vec::new();
    // Worker starts before the window; provider failures are attributed to
    // it by pid.
    lines.push(worker_start_line(
        "2026-09-10T19:42:09.064Z",
        crashed_worker,
        53615,
    ));
    // Attach timeouts 20:02-20:21.
    for (ts, command) in [
        ("2026-09-10T20:02:39.764Z", "attach"),
        ("2026-09-10T20:08:37.410Z", "attach"),
        ("2026-09-10T20:09:16.853Z", "attach"),
        ("2026-09-10T20:21:53.062Z", "attach"),
    ] {
        lines.push(supervisor(
            ts,
            &format!(
                "Supervisor command {command} failed: Error: Timed out waiting for daemon worker response to {command}\n    at Timeout._onTimeout (node:internal/timers:618:7)"
            ),
        ));
    }
    // Per-session catch-up timeouts for 2339fb7da605 and one other session.
    lines.push(supervisor(
        "2026-09-10T20:02:33.708Z",
        "Failed to catch up client daemon-client:ac0fbf2a for dcdced964c0d: Error: Timed out waiting for daemon worker response to attach",
    ));
    for ts in [
        "2026-09-10T20:04:50.397Z",
        "2026-09-10T20:11:29.190Z",
        "2026-09-10T20:14:57.615Z",
    ] {
        lines.push(supervisor(
            ts,
            "Failed to catch up client daemon-client:dc5ad892 for 2339fb7da605: Error: Timed out waiting for daemon worker response to attach",
        ));
    }
    lines.push(supervisor(
        "2026-09-10T20:21:58.137Z",
        "Could not list heartbeats from a worker: Timed out waiting for daemon worker response to heartbeats_list",
    ));
    lines.push(supervisor(
        "2026-09-10T20:02:30.000Z",
        "Supervisor command list_agent_peers failed: Error: Worker authentication failed\n    at handleCommand (chunk.js:1:1)",
    ));
    // Provider stream failures from the overloaded worker.
    for index in 0..30 {
        lines.push(
            json!({
                "ts": format!("2026-09-10T20:{:02}:{:02}.000Z", 2 + index / 2, index % 60),
                "level": "error",
                "component": "ai.provider",
                "pid": 53615,
                "msg": "provider stream failure",
                "kind": if index % 5 == 0 { "server_error" } else { "rate_limit" },
                "status": if index % 5 == 0 { 504 } else { 429 },
            })
            .to_string(),
        );
    }
    // EPIPE crash: logged once by the worker and once via the stderr
    // forward.
    lines.push(json!({
        "ts": "2026-09-10T20:23:24.945Z",
        "component": "coding-agent.daemon",
        "socketPath": crashed_worker,
        "pid": 53615,
        "msg": "uncaught exception: Error: write EPIPE\n    at afterWriteDispatched (node:internal/stream_base_commons:159:15)",
    })
    .to_string());
    lines.push(supervisor(
        "2026-09-10T20:23:24.945Z",
        "Session worker 5b1d3aeb91ee stderr: uncaught exception: Error: write EPIPE",
    ));
    lines.push(supervisor(
        "2026-09-10T20:23:24.946Z",
        "Session worker 5b1d3aeb91ee stderr:     at afterWriteDispatched (node:internal/stream_base_commons:159:15)",
    ));
    // Recovery: worker replaced, backlogged uncertain operations held.
    let operations = [
        std::iter::repeat_n("tool_execution_start", 408),
        std::iter::repeat_n("auto_retry_end", 62),
        std::iter::repeat_n("agent_end", 47),
        std::iter::repeat_n("message_start", 16),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(", ");
    lines.push(supervisor(
        "2026-09-10T20:23:29.521Z",
        &format!(
            "Recovered worker 5b1d3aeb91ee without replaying uncertain operations: {operations}"
        ),
    ));
    lines.push(supervisor(
        "2026-09-10T20:23:39.520Z",
        "Could not adopt worker 5b1d3aeb91ee: Error: Session worker process is no longer running",
    ));
    lines
}

#[test]
fn a_clean_run_shows_no_anomalies() {
    let text = report_for(&[
        supervisor_line(
            "2026-09-10T20:00:05.000Z",
            "Prime Agent daemon supervisor e14de15c listening on /tmp/prime-agent-501/daemon.sock",
            json!({}),
        ),
        supervisor_line(
            "2026-09-10T20:01:00.000Z",
            "Session worker 477fef4e85a8 stderr: Prime Agent daemon listening on /tmp/prime-agent-501/worker-a-477fef4e85a8.sock",
            json!({}),
        ),
        supervisor_line("2026-09-10T20:02:00.000Z", "Migrated 2 scheduled jobs into session artifacts", json!({})),
        supervisor_line(
            "2026-09-10T20:10:00.000Z",
            "Session worker 477fef4e85a8 stderr: shutdown command received over socket; 1 active session(s) will be closed",
            json!({}),
        ),
        supervisor_line(
            "2026-09-10T20:10:01.000Z",
            "Session worker 477fef4e85a8 stderr: shutting down (exit 0); closing 1 active session(s)",
            json!({}),
        ),
        supervisor_line(
            "2026-09-10T20:11:00.000Z",
            "Evicted empty session worker 477fef4e85a8 root=01a0-abc on last client detach",
            json!({}),
        ),
    ]);
    assert!(text.contains("Supervisor events"));
    assert!(text.contains("worker 477fef4e85a8 started"));
    assert!(text.contains("worker 477fef4e85a8 stop requested (1 active session(s))"));
    assert!(text.contains("worker 477fef4e85a8 stopped (exit 0, 1 session(s) closed)"));
    assert!(text.contains("evicted empty session worker 477fef4e85a8 on last detach"));
    assert!(text.contains("migrated 2 scheduled jobs into session artifacts"));
    let anomalies = text.split("Session anomalies").nth(1).unwrap_or("");
    let anomalies = anomalies.split("Recovery").next().unwrap_or("");
    assert!(anomalies.contains("(none)"), "{anomalies}");
    assert!(!anomalies.contains("timeout"));
    assert!(!text.contains("critical"));
}

#[test]
fn reconstructs_the_incident_narrative_in_one_report() {
    let text = report_for(&incident_fixture_lines());
    // Timeouts aggregated with count and span.
    assert!(
        text.contains(
            "command attach failed: timed out waiting for worker response (x4, until 09-10 20:21:53)"
        ),
        "{text}"
    );
    assert!(
        text.contains(
            "client catch-up failed for session 2339fb7da605: Timed out waiting for daemon worker response to attach (x3, until 09-10 20:14:57)"
        ),
        "{text}"
    );
    assert!(text.contains("command list_agent_peers failed: worker authentication failed"));
    // The crash appears once, critical, with the EPIPE cause.
    assert_eq!(text.matches("crashed").count(), 1);
    assert!(
        text.contains("09-10 20:23:24  critical  worker 5b1d3aeb91ee crashed: uncaught exception: Error: write EPIPE"),
        "{text}"
    );
    // Recovery with the held backlog and its operation breakdown.
    assert!(
        text.contains(
            "worker 5b1d3aeb91ee recovered; 533 uncertain operations not replayed (tool_execution_start x408, auto_retry_end x62, agent_end x47, message_start x16)"
        ),
        "{text}"
    );
    assert!(text.contains(
        "could not adopt worker 5b1d3aeb91ee: Session worker process is no longer running"
    ));
    // Anomalies: a timeout stall, an auth failure, and provider failures
    // attributed to the crashed worker.
    assert!(text.contains("/tmp/prime-agent-501/daemon.sock: 5 command timeouts over 19m18s"));
    assert!(text.contains("session 2339fb7da605: 3 command timeouts over 10m7s"));
    assert!(text.contains("provider stream failure (rate_limit 429) for worker 5b1d3aeb91ee (x24"));
    assert!(text.contains("provider stream failure (server_error 504) for worker 5b1d3aeb91ee (x6"));
}

#[test]
fn excludes_events_outside_the_window() {
    let options = IncidentReportOptions {
        since_ms: 1_789_070_700_000, // 2026-09-10T20:05:00Z
        until_ms: 1_789_071_000_000, // 2026-09-10T20:10:00Z
        ..Default::default()
    };
    let text = report_for_with(&incident_fixture_lines(), &options);
    assert!(
        text.contains("command attach failed: timed out waiting for worker response (x2, until 09-10 20:09:16)"),
        "{text}"
    );
    assert!(!text.contains("20:21:53"));
    assert!(!text.contains("write EPIPE"));
    assert!(!text.contains("Recovered worker"));
}

#[test]
fn filters_to_events_naming_the_session_with_prefix_matching() {
    let lines = incident_fixture_lines();
    let full = report_for(&lines);
    let options = IncidentReportOptions {
        session: Some("2339fb7".to_string()),
        ..default_options()
    };
    let filtered = report_for_with(&lines, &options);
    assert!(filtered.contains("client catch-up failed for session 2339fb7da605"));
    assert!(filtered.contains("session 2339fb7da605: 3 command timeouts over 10m7s"));
    assert!(filtered.contains("Session filter: 2339fb7"));
    assert!(!filtered.contains("command attach failed: timed out"));
    assert!(!filtered.contains("write EPIPE"));
    assert!(!filtered.contains("dcdced964c0d"));
    assert!(full.contains("dcdced964c0d"));
}

#[test]
fn matches_session_names_quoted_in_log_messages() {
    let options = IncidentReportOptions {
        session: Some("Faerie".to_string()),
        ..default_options()
    };
    let text = report_for_with(
        &[supervisor_line(
            "2026-09-10T20:05:00.000Z",
            r#"Supervisor command set_session_name failed: Error: Agent name "Faerie" is unavailable"#,
            json!({}),
        )],
        &options,
    );
    assert!(text.contains(r#"Agent name "Faerie" is unavailable"#));
}

#[test]
fn a_passivation_event_with_an_empty_name_matches_no_filter() {
    // daemon-mode logs `name=""` when the session has no name; that empty
    // token must not prefix-match every --session value.
    let options = IncidentReportOptions {
        session: Some("aabbccddeeff".to_string()),
        ..default_options()
    };
    let text = report_for_with(
        &[daemon_line(
            "2026-09-10T20:05:00.000Z",
            "/tmp/prime-agent-501/worker-98ed5cb228d2-5b1d3aeb91ee.sock",
            r#"Passivated idle child sessionId=feedface1234 name="" idleMinutes=5"#,
        )],
        &options,
    );
    assert!(text.contains(r#"reference session "aabbccddeeff""#));
}

#[test]
fn keeps_session_tokens_from_worker_command_failures() {
    let options = IncidentReportOptions {
        session: Some("Faerie".to_string()),
        ..default_options()
    };
    let text = report_for_with(
        &[daemon_line(
            "2026-09-10T20:05:00.000Z",
            "/tmp/prime-agent-501/worker-98ed5cb228d2-5b1d3aeb91ee.sock",
            r#"daemon command "set_session_name" failed: Error: Agent name "Faerie" is unavailable"#,
        )],
        &options,
    );
    assert!(text.contains(r#"Agent name "Faerie" is unavailable"#));
}

#[test]
fn says_clearly_when_nothing_in_the_window_references_the_session() {
    let options = IncidentReportOptions {
        session: Some("deadbeef1234".to_string()),
        ..default_options()
    };
    let text = report_for_with(&incident_fixture_lines(), &options);
    assert!(text.contains(r#"reference session "deadbeef1234""#));
}

#[test]
fn keeps_anomalies_and_aggregation_per_daemon_socket() {
    let daemon_a = "/tmp/prime-agent-501/daemon.sock";
    let daemon_b = "/tmp/other/daemon.sock";
    let mut lines = Vec::new();
    for (socket_path, times) in [
        (daemon_a, ["20:02", "20:08", "20:09", "20:21"].as_slice()),
        (daemon_b, ["20:03", "20:10", "20:30"].as_slice()),
    ] {
        for time in times {
            lines.push(json!({
                "ts": format!("2026-09-10T{time}:00.000Z"),
                "component": "coding-agent.daemon-supervisor",
                "socketPath": socket_path,
                "msg": "Supervisor command attach failed: Error: Timed out waiting for daemon worker response to attach",
            })
            .to_string());
        }
    }
    let text = report_for(&lines);
    assert!(
        text.contains(&format!("{daemon_a}: 4 command timeouts over 19m")),
        "{text}"
    );
    assert!(text.contains(&format!("{daemon_b}: 3 command timeouts over 27m")));
    assert!(
        text.contains("command attach failed: timed out waiting for worker response (x4, until 09-10 20:21:00)"),
        "{text}"
    );
}

#[test]
fn keeps_a_same_component_worker_restart_within_two_seconds() {
    let socket_path = "/tmp/prime-agent-501/worker-98ed5cb228d2-5b1d3aeb91ee.sock";
    let text = report_for(&[
        worker_start_line("2026-09-10T20:00:00.000Z", socket_path, 100),
        worker_start_line("2026-09-10T20:00:01.000Z", socket_path, 200),
    ]);
    assert!(text.contains("worker 5b1d3aeb91ee started (x2, until 09-10 20:00:01)"));
}

#[test]
fn the_report_layout_matches_the_ts_shape() {
    // One supervisor-start event in a 30-minute window: the exact TS
    // frame, from the header through the trimmed tail.
    let options = default_options();
    let lines = vec![supervisor_line(
        "2026-09-10T20:00:05.000Z",
        "Prime Agent daemon supervisor e14de15c listening on /tmp/prime-agent-501/daemon.sock",
        json!({}),
    )];
    let text = build_incident_report(&entries(&lines), &options).text;
    let severity = format!("{:<8}", "info");
    let expected = [
        "Prime Agent incident timeline",
        "Window: 09-10 20:00:00 → 09-10 20:30:00 UTC (30m)",
        "",
        "Supervisor events",
        &format!("  09-10 20:00:05  {severity}  daemon supervisor listening"),
        "",
        "Session anomalies",
        "  (none)",
        "",
        "Recovery",
        "  (none)",
    ]
    .join("\n");
    assert_eq!(text, expected);
}
