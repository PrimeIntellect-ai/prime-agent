//! Log-source tests over a fixture agent dir (the TS `runIncident over a
//! fixture agent dir` suite, asserted on the composed report text the
//! command prints).

use super::*;

fn supervisor_line(ts: &str, msg: &str) -> String {
    format!(
        r#"{{"ts":"{ts}","level":"warn","component":"coding-agent.daemon-supervisor","pid":15026,"msg":{}}}"#,
        serde_json::json!(msg)
    )
}

/// The composed report text for a window over the redirected agent dir
/// (what `run_incident` prints).
fn report_text(since: &str, until: &str) -> String {
    let options = IncidentCommandOptions {
        since: Some(since.to_string()),
        until: Some(until.to_string()),
        session: None,
    };
    let now_ms = crate::util_time::now_ms() as i64;
    incident_report_text(&options, None, now_ms)
        .expect("the window resolves")
        .expect("a report")
}

/// The env-lock serializes the whole body: one lock covers the env var
/// swap AND the reads; the previous value is restored afterwards.
fn with_agent_dir(body: impl FnOnce(&Path)) {
    let _guard = crate::config::env_lock();
    let previous = std::env::var_os(crate::config::ENV_AGENT_DIR);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().to_path_buf();
    std::fs::create_dir_all(agent_dir.join("logs")).expect("logs dir");
    std::env::set_var(crate::config::ENV_AGENT_DIR, &agent_dir);
    body(&agent_dir);
    match previous {
        Some(previous) => std::env::set_var(crate::config::ENV_AGENT_DIR, previous),
        None => std::env::remove_var(crate::config::ENV_AGENT_DIR),
    }
}

#[test]
fn tolerates_malformed_lines_and_reports_them_as_skipped() {
    with_agent_dir(|agent_dir| {
        let good = supervisor_line(
            "2026-09-10T20:02:39.764Z",
            "Supervisor command attach failed: Error: Timed out waiting for daemon worker response to attach",
        );
        let contents = [
            "this is not json",
            r#"{"noTs":true,"msg":"missing ts"}"#,
            good.as_str(),
            "",
        ]
        .join("\n");
        std::fs::write(agent_dir.join("logs/agent.jsonl"), format!("{contents}\n"))
            .expect("write log");
        let text = report_text("2026-09-10T20:00", "2026-09-10T20:30");
        assert!(text.contains("command attach failed: timed out waiting for worker response"));
        assert!(text.contains("3 lines scanned, 1 events in window, 2 unreadable skipped"));
        assert!(text.contains("Source: "));
        assert!(text.contains("agent.jsonl"));
    });
}

/// Unix-only: the decoy is a directory carrying a future mtime via
/// `File::set_times` on a directory handle, which Windows cannot open.
#[cfg(unix)]
#[test]
fn falls_back_to_the_newest_per_daemon_log_when_agent_jsonl_is_absent() {
    with_agent_dir(|agent_dir| {
        std::fs::write(
            agent_dir.join("logs/old-sock.a1b2c3d4.log"),
            "[2026-09-09T10:00:00.000Z] supervisor: Daemon supervisor startup failed: Error: Lock file is already being held\n",
        )
        .expect("write old log");
        std::fs::write(
            agent_dir.join("logs/daemon.sock.98ed5cb2.log"),
            [
                "[2026-09-10T20:00:05.000Z] supervisor: Daemon supervisor startup failed: Error: Lock file is already being held",
                "[2026-09-10T20:23:24.945Z] uncaught exception: Error: write EPIPE",
                "[2026-09-10T20:23:29.521Z] supervisor: Recovered worker 5b1d3aeb91ee without replaying uncertain operations: tool_execution_start, agent_end",
            ]
            .join("\n"),
        )
        .expect("write newest log");
        // A future-dated DIRECTORY matching the log pattern: it must not be
        // picked as the fallback (TS `statSync().isFile` filter), or it
        // would hide both valid daemon logs behind a failed read.
        let decoy_dir = agent_dir.join("logs/daemon.sock.deadbeef.log");
        std::fs::create_dir(&decoy_dir).expect("decoy dir");
        let decoy = std::fs::File::open(&decoy_dir).expect("open decoy");
        let future = std::time::SystemTime::now() + std::time::Duration::from_secs(60);
        decoy
            .set_times(std::fs::FileTimes::new().set_modified(future))
            .expect("future mtime");
        let text = report_text("2026-09-10T20:00", "2026-09-10T20:30");
        assert!(text.contains("daemon.sock.98ed5cb2.log"), "{text}");
        assert!(text.contains("supervisor startup blocked: another daemon holds the lock"));
        assert!(
            text.contains(
                "worker 5b1d3aeb91ee recovered; 2 uncertain operations not replayed (agent_end x1, tool_execution_start x1)"
            ),
            "{text}"
        );
    });
}

#[test]
fn falls_back_to_daemon_logs_whose_socket_basename_has_no_sock_suffix() {
    // A daemon started with `--daemon-socket /tmp/prime-daemon` writes
    // prime-daemon.<hash>.log, which has no .sock segment to match on.
    with_agent_dir(|agent_dir| {
        std::fs::write(
            agent_dir.join("logs/prime-daemon.a1b2c3d4.log"),
            "[2026-09-10T20:00:05.000Z] supervisor: Daemon supervisor startup failed: Error: Lock file is already being held\n",
        )
        .expect("write log");
        let text = report_text("2026-09-10T20:00", "2026-09-10T20:30");
        assert!(text.contains("prime-daemon.a1b2c3d4.log"), "{text}");
        assert!(text.contains("supervisor startup blocked: another daemon holds the lock"));
    });
}

#[test]
fn falls_back_when_agent_jsonl_is_empty_or_unreadable() {
    with_agent_dir(|agent_dir| {
        let daemon_log = [
            "[2026-09-10T20:23:24.945Z] uncaught exception: Error: write EPIPE",
            "[2026-09-10T20:23:29.521Z] supervisor: Recovered worker 5b1d3aeb91ee without replaying uncertain operations: tool_execution_start, agent_end",
        ]
        .join("\n");
        std::fs::write(
            agent_dir.join("logs/daemon.sock.98ed5cb2.log"),
            format!("{daemon_log}\n"),
        )
        .expect("write daemon log");
        // Unreadable agent.jsonl: nothing parses.
        std::fs::write(
            agent_dir.join("logs/agent.jsonl"),
            "this is not json\nalso not json\n",
        )
        .expect("write broken log");
        let text = report_text("2026-09-10T20:00", "2026-09-10T20:30");
        assert!(text.contains("daemon.sock.98ed5cb2.log"), "{text}");
        assert!(
            text.contains("worker crashed: uncaught exception: Error: write EPIPE"),
            "{text}"
        );
        assert!(text.contains("worker 5b1d3aeb91ee recovered; 2 uncertain operations not replayed"));
        // Empty agent.jsonl: zero parsed entries also triggers the
        // fallback.
        std::fs::write(agent_dir.join("logs/agent.jsonl"), "").expect("truncate log");
        let text = report_text("2026-09-10T20:00", "2026-09-10T20:30");
        assert!(text.contains("daemon.sock.98ed5cb2.log"), "{text}");
        assert!(
            text.contains("worker crashed: uncaught exception: Error: write EPIPE"),
            "{text}"
        );
    });
}

#[test]
fn does_not_fall_back_when_agent_jsonl_parses_but_has_no_in_window_events() {
    with_agent_dir(|agent_dir| {
        let out_of_window = supervisor_line(
            "2026-09-01T10:00:00.000Z",
            "Supervisor command attach failed: Error: Timed out waiting for daemon worker response to attach",
        );
        std::fs::write(
            agent_dir.join("logs/agent.jsonl"),
            format!("{out_of_window}\n"),
        )
        .expect("write log");
        std::fs::write(
            agent_dir.join("logs/daemon.sock.98ed5cb2.log"),
            "[2026-09-10T20:23:24.945Z] supervisor: Supervisor command attach failed: Error: Timed out waiting for daemon worker response to attach\n",
        )
        .expect("write daemon log");
        let text = report_text("2026-09-10T20:00", "2026-09-10T20:30");
        assert!(text.contains("agent.jsonl"), "{text}");
        assert!(!text.contains("daemon.sock.98ed5cb2.log"), "{text}");
        assert!(text.contains("(none)"), "{text}");
    });
}

#[test]
fn reports_missing_logs_clearly() {
    with_agent_dir(|agent_dir| {
        // No logs at all: the command prints the missing-logs message
        // instead of an empty timeline (TS runIncident's early return).
        let options = IncidentCommandOptions {
            since: Some("2026-09-10T20:00".to_string()),
            until: Some("2026-09-10T20:30".to_string()),
            session: None,
        };
        let now_ms = crate::util_time::now_ms() as i64;
        // No logs at all: the composed text is None, which is what gates
        // the "No daemon logs found under <dir>." message.
        assert!(incident_report_text(&options, None, now_ms)
            .expect("the window resolves")
            .is_none());
        let source = read_incident_log_entries();
        assert!(source.entries.is_empty());
        assert_eq!(source.scanned_count, 0);
        assert_eq!(source.source, "");
    });
}
