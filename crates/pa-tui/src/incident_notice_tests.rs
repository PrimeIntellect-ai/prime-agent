//! Incident notice tests (the TS
//! `agents-view-incident-notice.test.ts` pure suites: derivation,
//! dismissal horizons, and rotation-safe incremental reads).

use super::*;

const DAEMON_SOCKET: &str = "/tmp/prime-agent-501/daemon.sock";

fn log_line(fields: &[(&str, serde_json::Value)]) -> IncidentLogEntry {
    let mut record = serde_json::Map::new();
    record.insert("level".to_string(), serde_json::json!("warn"));
    for (key, value) in fields {
        record.insert((*key).to_string(), value.clone());
    }
    parse_incident_log_line(&serde_json::Value::Object(record).to_string())
        .expect("the fixture line parses")
}

/// ISO-8601 UTC with millisecond precision (the daemon's `ts` shape).
fn iso_ms(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let secs_of_day = ms.rem_euclid(86_400_000) / 1_000;
    let millis = ms.rem_euclid(1_000);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        secs_of_day / 3_600,
        secs_of_day / 60 % 60,
        secs_of_day % 60
    )
}

fn ts_ago(base_ms: i64, ago_ms: i64) -> String {
    iso_ms(base_ms - ago_ms)
}

fn supervisor_start_line(base_ms: i64, minutes_ago: i64, generation: &str) -> IncidentLogEntry {
    log_line(&[
        (
            "ts",
            serde_json::json!(ts_ago(base_ms, minutes_ago * 60_000)),
        ),
        (
            "component",
            serde_json::json!("coding-agent.daemon-supervisor"),
        ),
        (
            "msg",
            serde_json::json!(format!(
                "Prime Agent daemon supervisor {generation} listening on {DAEMON_SOCKET}"
            )),
        ),
        ("socketPath", serde_json::json!(DAEMON_SOCKET)),
        ("pid", serde_json::json!(15026)),
    ])
}

fn failed_start_line(base_ms: i64, minutes_ago: i64) -> IncidentLogEntry {
    log_line(&[
        ("ts", serde_json::json!(ts_ago(base_ms, minutes_ago * 60_000))),
        (
            "component",
            serde_json::json!("coding-agent.daemon-supervisor"),
        ),
        ("socketPath", serde_json::json!(DAEMON_SOCKET)),
        (
            "msg",
            serde_json::json!(
                "Daemon supervisor startup failed: lock file is already being held by another process"
            ),
        ),
    ])
}

fn command_timeout_line(base_ms: i64, minutes_ago: i64, socket_path: &str) -> IncidentLogEntry {
    log_line(&[
        ("ts", serde_json::json!(ts_ago(base_ms, minutes_ago * 60_000))),
        (
            "component",
            serde_json::json!("coding-agent.daemon-supervisor"),
        ),
        ("socketPath", serde_json::json!(socket_path)),
        (
            "msg",
            serde_json::json!("Supervisor command attach failed: Error: Timed out waiting for daemon worker response to attach\n    at Timeout._onTimeout (node:internal/timers:618:7)"),
        ),
    ])
}

const BASE_MS: i64 = 1_789_597_800_000; // 2026-09-16T22:30:00Z

#[test]
fn anchors_each_subjects_timeout_burst_at_its_own_clusters_latest_timeout() {
    // Several daemon sockets, each with its own stall: the per-subject
    // cluster lookup must never leak or mis-anchor across subjects.
    let other_socket = "/tmp/prime-agent-501/daemon-other.sock";
    let spaced_socket = "/tmp/prime-agent-501/daemon-spaced.sock";
    let mut entries = Vec::new();
    for minutes in [200, 190, 180, 30, 29] {
        entries.push(command_timeout_line(BASE_MS, minutes, spaced_socket));
    }
    for (minutes, socket_path) in [
        (30, DAEMON_SOCKET),
        (25, other_socket),
        (20, DAEMON_SOCKET),
        (5, other_socket),
    ] {
        entries.push(command_timeout_line(BASE_MS, minutes, socket_path));
    }
    let bursts: Vec<IncidentNotice> = derive_incident_notices(&entries, BASE_MS)
        .into_iter()
        .filter(|notice| notice.kind == IncidentNoticeKind::TimeoutBurst)
        .collect();
    assert_eq!(bursts.len(), 3, "{bursts:?}");
    let by_subject = |subject: &str| {
        bursts
            .iter()
            .find(|notice| notice.subject == subject)
            .unwrap_or_else(|| panic!("no burst for {subject}: {bursts:?}"))
    };
    assert_eq!(by_subject(DAEMON_SOCKET).time_ms, BASE_MS - 20 * 60_000);
    assert_eq!(by_subject(other_socket).time_ms, BASE_MS - 5 * 60_000);
    assert!(by_subject(spaced_socket)
        .text
        .contains("3 command timeouts over 20m"));
    assert_eq!(by_subject(spaced_socket).time_ms, BASE_MS - 180 * 60_000);
}

#[test]
fn derives_an_update_restart_only_from_repeated_successful_starts() {
    let replaced = vec![
        supervisor_start_line(BASE_MS, 120, "e14de15c"),
        supervisor_start_line(BASE_MS, 60, "e14de15c"),
    ];
    let restarts = derive_incident_notices(&replaced, BASE_MS);
    assert_eq!(restarts.len(), 1, "{restarts:?}");
    assert_eq!(restarts[0].kind, IncidentNoticeKind::UpdateRestart);
    assert_eq!(restarts[0].severity, IncidentSeverity::Info);
    assert_eq!(restarts[0].subject, DAEMON_SOCKET);
    assert_eq!(restarts[0].time_ms, replaced[1].time_ms);
    assert_eq!(
        restarts[0].text,
        format!(
            "daemon restarted for update at {}",
            format_incident_notice_time(replaced[1].time_ms, BASE_MS)
        )
    );

    // A first-ever start is routine; a failed startup (lock held) never
    // counts toward a replacement, or two failed spawns on one socket
    // would read as an update restart.
    assert!(
        derive_incident_notices(&[supervisor_start_line(BASE_MS, 60, "e14de15c")], BASE_MS)
            .is_empty()
    );
    assert!(derive_incident_notices(
        &[
            failed_start_line(BASE_MS, 30),
            supervisor_start_line(BASE_MS, 20, "e14de15c"),
        ],
        BASE_MS
    )
    .is_empty());
}

#[test]
fn the_notice_time_formats_like_the_ts_label_style() {
    // Same UTC calendar day: the bare time.
    assert_eq!(
        format_incident_notice_time(BASE_MS - 120_000, BASE_MS),
        "22:28"
    );
    // Another day in the same year: M/D HH:MM.
    let yesterday =
        pa_types::incident::timestamp_to_ms("2026-09-15T22:30:00.000Z").expect("the fixture date");
    assert_eq!(
        format_incident_notice_time(yesterday, BASE_MS),
        "9/15 22:30"
    );
    // Across a year boundary: YY/M/D HH:MM.
    let last_year =
        pa_types::incident::timestamp_to_ms("2025-03-05T01:02:03.000Z").expect("the fixture date");
    assert_eq!(
        format_incident_notice_time(last_year, BASE_MS),
        "25/3/5 01:02"
    );
}

fn agent_log_dir(name: &str) -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let logs = dir.path().join(name);
    std::fs::create_dir_all(&logs).expect("logs dir");
    (dir, logs)
}

fn write_log(path: &Path, lines: &[String]) {
    if lines.is_empty() {
        std::fs::write(path, "").expect("write log");
        return;
    }
    std::fs::write(path, format!("{}\n", lines.join("\n"))).expect("write log");
}

fn append_log(path: &Path, lines: &[String]) {
    use std::io::Write as _;
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .expect("open log");
    file.write_all(format!("{}\n", lines.join("\n")).as_bytes())
        .expect("append log");
}

#[test]
fn re_shows_a_dismissed_timeout_burst_when_a_later_timeout_extends_it() {
    let (_dir, logs) = agent_log_dir("incident-extend");
    let log_path = logs.join("agent.jsonl");
    let line = |minutes: i64| {
        serde_json::json!({
            "ts": ts_ago(BASE_MS, minutes * 60_000),
            "component": "coding-agent.daemon-supervisor",
            "socketPath": DAEMON_SOCKET,
            "msg": "Supervisor command attach failed: Error: Timed out waiting for daemon worker response to attach",
        })
        .to_string()
    };
    write_log(&log_path, &[line(30), line(29)]);
    let mut state = IncidentNoticeState::new();
    assert!(refresh_incident_notice_state(
        &mut state, &log_path, BASE_MS
    ));
    assert!(dismiss_incident_notice_state(&mut state));
    // A later timeout extends the burst past the dismissed horizon: the
    // notice reappears instead of staying hidden until the first timeout
    // ages out.
    append_log(&log_path, &[line(5)]);
    assert!(refresh_incident_notice_state(
        &mut state, &log_path, BASE_MS
    ));
    let notice = state.notice.as_ref().expect("the re-surfaced notice");
    assert_eq!(notice.kind, IncidentNoticeKind::TimeoutBurst);
    assert_eq!(notice.time_ms, BASE_MS - 5 * 60_000);
}

#[test]
fn keeps_a_dismissed_timeout_burst_hidden_when_a_later_timeout_is_isolated() {
    let (_dir, logs) = agent_log_dir("incident-isolated");
    let log_path = logs.join("agent.jsonl");
    let line = |minutes: i64| {
        serde_json::json!({
            "ts": ts_ago(BASE_MS, minutes * 60_000),
            "component": "coding-agent.daemon-supervisor",
            "socketPath": DAEMON_SOCKET,
            "msg": "Supervisor command attach failed: Error: Timed out waiting for daemon worker response to attach",
        })
        .to_string()
    };
    write_log(&log_path, &[line(60), line(59)]);
    let mut state = IncidentNoticeState::new();
    assert!(refresh_incident_notice_state(
        &mut state, &log_path, BASE_MS
    ));
    assert!(dismiss_incident_notice_state(&mut state));
    append_log(&log_path, &[line(5)]);
    assert!(!refresh_incident_notice_state(
        &mut state, &log_path, BASE_MS
    ));
}

#[test]
fn surfaces_a_crash_at_the_end_of_agent_jsonl_old_without_a_trailing_newline() {
    let (_dir, logs) = agent_log_dir("incident-old-tail");
    let log_path = logs.join("agent.jsonl");
    let crash = serde_json::json!({
        "ts": ts_ago(BASE_MS, 120_000),
        "component": "coding-agent.daemon-supervisor",
        "msg": "Session worker 5b1d3aeb91ee stderr: uncaught exception: Error: write EPIPE",
    })
    .to_string();
    // The rotated .old's final line has no trailing newline (a frozen
    // file): the bridge still reads it whole.
    std::fs::write(logs.join("agent.jsonl.old"), &crash).expect("write old log");
    std::fs::write(&log_path, "").expect("write empty log");
    let mut state = IncidentNoticeState::new();
    refresh_incident_notice_state(&mut state, &log_path, BASE_MS);
    let notice = state.notice.as_ref().expect("the crash notice");
    assert_eq!(notice.kind, IncidentNoticeKind::WorkerCrash);
}

#[test]
fn skips_the_old_bridge_when_a_rotation_makes_it_the_live_logs_own_generation() {
    let (_dir, logs) = agent_log_dir("incident-same-generation");
    let log_path = logs.join("agent.jsonl");
    let start = serde_json::json!({
        "ts": ts_ago(BASE_MS, 600 * 60_000),
        "component": "coding-agent.daemon-supervisor",
        "msg": format!("Prime Agent daemon supervisor e14de15c listening on {DAEMON_SOCKET}"),
        "socketPath": DAEMON_SOCKET,
        "pid": 15026,
    })
    .to_string();
    write_log(&log_path, &[start]);
    // A rename rotation landed between the live read and the .old read:
    // the .old path names the very file the live read consumed, and
    // bridging it would double the supervisor start.
    std::fs::hard_link(&log_path, logs.join("agent.jsonl.old")).expect("hard link");
    let mut state = IncidentNoticeState::new();
    refresh_incident_notice_state(&mut state, &log_path, BASE_MS);
    assert_eq!(state.entries.len(), 1);
}

#[test]
fn completes_the_un_consumed_tail_of_a_generation_that_rotates_out_mid_session() {
    let (_dir, logs) = agent_log_dir("incident-mid-rotation");
    let log_path = logs.join("agent.jsonl");
    let crash = |worker_id: &str, seconds_ago: i64| {
        serde_json::json!({
            "ts": ts_ago(BASE_MS, seconds_ago * 1_000),
            "component": "coding-agent.daemon-supervisor",
            "msg": format!("Session worker {worker_id} stderr: uncaught exception: Error: write EPIPE"),
        })
        .to_string()
    };
    write_log(&log_path, &[crash("5b1d3aeb91ee", 60)]);
    let mut state = IncidentNoticeState::new();
    refresh_incident_notice_state(&mut state, &log_path, BASE_MS);
    append_log(&log_path, &[crash("9f2c7a44b021", 30)]);
    // The log rotates out from under the consumed offset: the un-consumed
    // tail (the newer crash) must still surface through the offset
    // continuation from .old.
    std::fs::rename(&log_path, logs.join("agent.jsonl.old")).expect("rotate log");
    std::fs::write(&log_path, "").expect("fresh log");
    refresh_incident_notice_state(&mut state, &log_path, BASE_MS);
    let notice = state.notice.as_ref().expect("the stranded tail's notice");
    assert_eq!(notice.subject, "worker 9f2c7a44b021");
}

#[test]
fn a_missing_log_keeps_the_offsets_and_ages_the_notice_out() {
    let (_dir, logs) = agent_log_dir("incident-missing");
    let log_path = logs.join("agent.jsonl");
    let crash = serde_json::json!({
        "ts": ts_ago(BASE_MS, 120_000),
        "component": "coding-agent.daemon-supervisor",
        "msg": "Session worker 5b1d3aeb91ee stderr: uncaught exception: Error: write EPIPE",
    })
    .to_string();
    write_log(&log_path, &[crash]);
    let mut state = IncidentNoticeState::new();
    assert!(refresh_incident_notice_state(
        &mut state, &log_path, BASE_MS
    ));
    let (offset, file_id) = (state.log_offset, state.log_file_id.clone());
    // The log disappears (an unreadable log): the poll keeps the consumed
    // offset and file id — a re-tail would fabricate a second supervisor
    // start — and still re-derives, so the notice ages out with its
    // window.
    std::fs::remove_file(&log_path).expect("remove log");
    assert!(!refresh_incident_notice_state(
        &mut state, &log_path, BASE_MS
    ));
    assert_eq!(state.log_offset, offset);
    assert_eq!(state.log_file_id, file_id);
    // The notice expires with its window (entries older than 24h drop) —
    // Some -> None IS a changed line, so the poll reports it for re-render.
    let later = BASE_MS + INCIDENT_NOTICE_WINDOW_MS + 1_000;
    assert!(refresh_incident_notice_state(&mut state, &log_path, later));
    assert!(state.notice.is_none());
}

#[test]
fn the_initial_read_drops_a_torn_leading_line_but_keeps_a_boundary_line() {
    let (_dir, logs) = agent_log_dir("incident-tail-cut");
    let log_path = logs.join("agent.jsonl");
    let crash = |worker_id: &str, seconds_ago: i64| {
        serde_json::json!({
            "ts": ts_ago(BASE_MS, seconds_ago * 1_000),
            "component": "coding-agent.daemon-supervisor",
            "msg": format!("Session worker {worker_id} stderr: uncaught exception: Error: write EPIPE"),
        })
        .to_string()
    };
    // A log larger than the tail bound: the bounded tail starts mid-line
    // (the cut splits a filler record — the torn leading fragment drops)
    // and the newest record, the crash, still surfaces.
    let filler = serde_json::json!({
        "ts": ts_ago(BASE_MS, 600 * 60_000),
        "component": "coding-agent.daemon-supervisor",
        "msg": "filler event for the tail bound",
    })
    .to_string();
    let mut lines = Vec::new();
    while lines.len() * filler.len() <= INCIDENT_NOTICE_TAIL_BYTES as usize {
        lines.push(filler.clone());
    }
    lines.push(crash("5b1d3aeb91ee", 120));
    let payload = lines.join("\n") + "\n";
    std::fs::write(&log_path, &payload).expect("write log");
    let mut state = IncidentNoticeState::new();
    refresh_incident_notice_state(&mut state, &log_path, BASE_MS);
    let notice = state.notice.as_ref().expect("the crash notice");
    assert_eq!(notice.subject, "worker 5b1d3aeb91ee");
    // The bounded read consumed exactly the tail window of bytes.
    assert_eq!(
        state.log_offset,
        Some(payload.len() as u64),
        "the offset stops at the last complete record"
    );
}
