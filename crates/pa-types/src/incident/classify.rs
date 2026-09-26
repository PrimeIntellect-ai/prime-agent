//! Log-entry classification into incident events (TS
//! `classifyIncidentEntry` and its helpers).

use super::patterns::*;
use super::{
    error_message, first_line, lifecycle_classes, truncate_text, IncidentCategory, IncidentEvent,
    IncidentLogEntry, IncidentSeverity, RECOVERY_BREAKDOWN_LIMIT, SUMMARY_TRUNCATION,
};
use std::collections::HashMap;

/// The worker id a socket path names, if any (TS
/// `workerIdFromSocketPath`).
///
/// Splitting on both separators so Windows named-pipe paths
/// (`\\.\pipe\...`) resolve to their last segment on any platform, not
/// only on win32.
pub fn worker_id_from_socket_path(socket_path: Option<&str>) -> Option<&str> {
    let socket_path = socket_path?;
    let name = socket_path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(socket_path);
    WORKER_SOCKET
        .captures(name)
        .and_then(|captures| captures.get(1))
        .map(|group| group.as_str())
}

/// One log sighting of a worker id owning a pid at a timestamp (TS
/// `WorkerPidSighting`).
#[derive(Debug, Clone, PartialEq)]
pub struct WorkerPidSighting {
    pub time_ms: i64,
    pub worker_id: String,
}

/// pid -> worker-id sightings, ordered by time (TS `WorkerPidMap`). A pid
/// can be reused by a later worker, so attribution picks the owner at
/// the event time, not the union of every id ever seen on the pid.
pub type WorkerPidMap = HashMap<i64, Vec<WorkerPidSighting>>;

/// Map pid -> worker-id sightings from entries whose socket path names a
/// worker socket (TS `collectWorkerPidMap`).
pub fn collect_worker_pid_map(entries: &[IncidentLogEntry]) -> WorkerPidMap {
    let mut map: WorkerPidMap = WorkerPidMap::new();
    for entry in entries {
        let Some(worker_id) = worker_id_from_socket_path(entry.socket_path.as_deref()) else {
            continue;
        };
        let Some(pid) = entry.pid else {
            continue;
        };
        map.entry(pid).or_default().push(WorkerPidSighting {
            time_ms: entry.time_ms,
            worker_id: worker_id.to_string(),
        });
    }
    for sightings in map.values_mut() {
        sightings.sort_by_key(|sighting| sighting.time_ms);
    }
    map
}

/// The worker that owned `pid` at `time_ms`: the latest sighting at or
/// before it (TS `workerIdForPid`).
fn worker_id_for_pid(worker_pids: &WorkerPidMap, pid: Option<i64>, time_ms: i64) -> Option<String> {
    let pid = pid?;
    let sightings = worker_pids.get(&pid)?;
    let mut worker_id: Option<&WorkerPidSighting> = None;
    for sighting in sightings {
        if sighting.time_ms <= time_ms {
            worker_id = Some(sighting);
        } else {
            break;
        }
    }
    worker_id.map(|sighting| sighting.worker_id.clone())
}

/// One classified worker stderr body (TS `classifyWorkerStderrBody`'s
/// return shape: an event without time or category).
#[derive(Debug, Clone, PartialEq)]
struct WorkerStderrEvent {
    severity: IncidentSeverity,
    event_class: &'static str,
    subject: String,
    summary: String,
    tokens: Vec<String>,
}

/// Build an event from an entry (TS `event`).
fn event(
    entry: &IncidentLogEntry,
    severity: IncidentSeverity,
    category: IncidentCategory,
    event_class: &str,
    subject: impl Into<String>,
    summary: impl Into<String>,
) -> IncidentEvent {
    incident_event(
        entry,
        severity,
        category,
        event_class,
        subject,
        summary,
        Vec::new(),
    )
}

/// Build an event from an entry with filter tokens.
fn incident_event(
    entry: &IncidentLogEntry,
    severity: IncidentSeverity,
    category: IncidentCategory,
    event_class: &str,
    subject: impl Into<String>,
    summary: impl Into<String>,
    tokens: Vec<String>,
) -> IncidentEvent {
    IncidentEvent {
        time_ms: entry.time_ms,
        severity,
        category,
        event_class: event_class.to_string(),
        subject: subject.into(),
        summary: summary.into(),
        tokens,
    }
}

/// Key events on the entry's socket path so anomalies and aggregation
/// never mix entries from different daemons sharing one agent.jsonl;
/// entries without a socket field (the per-daemon fallback log) key on
/// `daemon` (TS `daemonSubject`).
fn daemon_subject(entry: &IncidentLogEntry) -> String {
    entry
        .socket_path
        .clone()
        .unwrap_or_else(|| "daemon".to_string())
}

/// The classification of a command failure (TS
/// `classifyCommandFailure`'s return shape).
struct CommandFailure {
    severity: IncidentSeverity,
    event_class: &'static str,
    summary: String,
    tokens: Vec<String>,
}

/// Classify the error body of a failed supervisor/daemon command (TS
/// `classifyCommandFailure`).
fn classify_command_failure(command: &str, error: &str) -> CommandFailure {
    let err = first_line(error);
    if err.contains("Timed out waiting for daemon worker response") {
        return CommandFailure {
            severity: IncidentSeverity::Error,
            event_class: "timeout",
            summary: format!("command {command} failed: timed out waiting for worker response"),
            tokens: Vec::new(),
        };
    }
    if AUTH_FAILED.is_match(err) {
        return CommandFailure {
            severity: IncidentSeverity::Error,
            event_class: "auth",
            summary: format!("command {command} failed: worker authentication failed"),
            tokens: Vec::new(),
        };
    }
    if err.contains("Session worker is starting") {
        return CommandFailure {
            severity: IncidentSeverity::Warn,
            event_class: "command-failure",
            summary: format!("command {command} failed: session worker is starting"),
            tokens: Vec::new(),
        };
    }
    if err.contains("preparing an update") {
        return CommandFailure {
            severity: IncidentSeverity::Info,
            event_class: "command-failure",
            summary: format!("command {command} failed: update restart in preparation"),
            tokens: Vec::new(),
        };
    }
    if err.contains("Session worker is recovering") {
        return CommandFailure {
            severity: IncidentSeverity::Warn,
            event_class: "command-failure",
            summary: format!("command {command} failed: session worker is recovering"),
            tokens: Vec::new(),
        };
    }
    if let Some(captures) = UNKNOWN_SESSION.captures(err) {
        let session_id = captures
            .get(1)
            .map_or(String::new(), |m| m.as_str().to_string());
        return CommandFailure {
            severity: IncidentSeverity::Warn,
            event_class: "command-failure",
            summary: format!("command {command} failed: unknown active session {session_id}"),
            tokens: vec![session_id],
        };
    }
    // Quoted strings can carry session names (e.g. Agent name "Faerie").
    let quoted_names: Vec<String> = err
        .match_indices('"')
        .filter_map(|(index, _)| {
            let rest = &err[index + 1..];
            let end = rest.find('"')?;
            let name = &rest[..end];
            (!name.contains('\n') && !name.is_empty()).then(|| name.to_string())
        })
        .collect();
    CommandFailure {
        severity: IncidentSeverity::Warn,
        event_class: "command-failure",
        summary: format!(
            "command {command} failed: {}",
            truncate_text(&error_message(first_line(err)), 100)
        ),
        tokens: quoted_names,
    }
}

/// Classify the body of a `Session worker <id> stderr: <body>` log line
/// (TS `classifyWorkerStderrBody`).
fn classify_worker_stderr_body(
    worker_id: &str,
    body: &str,
    include_generic: bool,
) -> Option<WorkerStderrEvent> {
    let tokens = vec![worker_id.to_string()];
    if body.trim().is_empty() || STACK_FRAME.is_match(body) {
        // Stack frames and blank lines belong to the previous stderr
        // event.
        return None;
    }
    let line = first_line(body);
    if WORKER_LISTENING.is_match(line) {
        return Some(WorkerStderrEvent {
            severity: IncidentSeverity::Info,
            event_class: "worker-start",
            subject: format!("worker {worker_id}"),
            summary: format!("worker {worker_id} started"),
            tokens,
        });
    }
    if CRASH_LINE.is_match(line) {
        return Some(WorkerStderrEvent {
            severity: IncidentSeverity::Critical,
            event_class: "worker-crash",
            subject: format!("worker {worker_id}"),
            summary: format!("worker {worker_id} crashed: {}", truncate_text(line, 100)),
            tokens,
        });
    }
    if let Some(captures) = SHUTDOWN_EXIT.captures(line) {
        let exit = captures.get(1).map_or("", |m| m.as_str());
        let sessions = captures.get(2).map_or("", |m| m.as_str());
        return Some(WorkerStderrEvent {
            severity: IncidentSeverity::Info,
            event_class: "worker-stop",
            subject: format!("worker {worker_id}"),
            summary: format!(
                "worker {worker_id} stopped (exit {exit}, {sessions} session(s) closed)"
            ),
            tokens,
        });
    }
    if let Some(captures) = SIGNAL_SHUTDOWN.captures(line) {
        let signal = captures.get(1).map_or("", |m| m.as_str());
        return Some(WorkerStderrEvent {
            severity: IncidentSeverity::Info,
            event_class: "worker-stop",
            subject: format!("worker {worker_id}"),
            summary: format!("worker {worker_id} received {signal}; shutting down"),
            tokens,
        });
    }
    if let Some(captures) = STOP_REQUESTED.captures(line) {
        let sessions = captures.get(1).map_or("", |m| m.as_str());
        return Some(WorkerStderrEvent {
            severity: IncidentSeverity::Info,
            event_class: "worker-stop",
            subject: format!("worker {worker_id}"),
            summary: format!("worker {worker_id} stop requested ({sessions} active session(s))"),
            tokens,
        });
    }
    if let Some(captures) = PASSIVATED.captures(line) {
        let session_id = captures.get(1).map_or("", |m| m.as_str());
        let idle_minutes = captures.get(3).map_or("", |m| m.as_str());
        // A missing session name logs as `name=""`; that empty token must
        // not become a filter key.
        let name = captures.get(2).map_or("", |m| m.as_str()).trim_matches('"');
        let mut passivated_tokens = vec![worker_id.to_string(), session_id.to_string()];
        if !name.is_empty() {
            passivated_tokens.push(name.to_string());
        }
        return Some(WorkerStderrEvent {
            severity: IncidentSeverity::Info,
            event_class: "worker-passivation",
            subject: format!("session {session_id}"),
            summary: format!("passivated idle child session {session_id} (idle {idle_minutes}m)"),
            tokens: passivated_tokens,
        });
    }
    if !include_generic {
        return None;
    }
    Some(WorkerStderrEvent {
        severity: IncidentSeverity::Warn,
        event_class: "worker-stderr",
        subject: format!("worker {worker_id}"),
        summary: format!("worker {worker_id} stderr: {}", truncate_text(line, 100)),
        tokens,
    })
}

/// Break a `Recovered ... uncertain operations: <list>` body into a count
/// and a ranked breakdown (TS `recoveryBreakdown`).
fn recovery_breakdown(operations: &str) -> (usize, String) {
    let list: Vec<&str> = operations
        .split(',')
        .map(str::trim)
        .filter(|operation| !operation.is_empty())
        .collect();
    if list.is_empty() {
        return (0, "none listed".to_string());
    }
    let mut counts: Vec<(&str, usize)> = Vec::new();
    for operation in &list {
        if let Some(entry) = counts.iter_mut().find(|(name, _)| name == operation) {
            entry.1 += 1;
        } else {
            counts.push((operation, 1));
        }
    }
    counts.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    let top = &counts[..RECOVERY_BREAKDOWN_LIMIT.min(counts.len())];
    let shown_count: usize = top.iter().map(|(_, count)| *count).sum();
    let rest = if counts.len() > RECOVERY_BREAKDOWN_LIMIT {
        format!(", +{} more", list.len() - shown_count)
    } else {
        String::new()
    };
    let breakdown = top
        .iter()
        .map(|(operation, count)| format!("{operation} x{count}"))
        .collect::<Vec<_>>()
        .join(", ");
    (list.len(), format!("{breakdown}{rest}"))
}

/// Classify a provider-failure entry into an aggregate-friendly anomaly
/// event (TS `providerFailureEvent`).
fn provider_failure_event(entry: &IncidentLogEntry, worker_pids: &WorkerPidMap) -> IncidentEvent {
    let worker_id = worker_id_for_pid(worker_pids, entry.pid, entry.time_ms);
    let subject = match (&worker_id, entry.pid) {
        (Some(worker_id), _) => format!("worker {worker_id}"),
        (None, Some(pid)) => format!("pid {pid}"),
        (None, None) => "provider".to_string(),
    };
    if entry.msg != "provider stream failure" {
        return event(
            entry,
            IncidentSeverity::Error,
            IncidentCategory::Anomaly,
            "provider",
            subject,
            truncate_text(first_line(&entry.msg), SUMMARY_TRUNCATION),
        );
    }
    let kind = entry
        .fields
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown");
    let status_text = match entry
        .fields
        .get("status")
        .and_then(serde_json::Value::as_i64)
    {
        Some(status) => format!(" {status}"),
        None => String::new(),
    };
    IncidentEvent {
        time_ms: entry.time_ms,
        severity: IncidentSeverity::Error,
        category: IncidentCategory::Anomaly,
        event_class: "provider".to_string(),
        summary: format!("provider stream failure ({kind}{status_text}) for {subject}"),
        tokens: worker_id.into_iter().collect(),
        subject,
    }
}

/// Classify one log entry into an incident event; `None` when the entry is
/// noise (TS `classifyIncidentEntry`).
pub fn classify_incident_entry(
    entry: &IncidentLogEntry,
    worker_pids: &WorkerPidMap,
) -> Option<IncidentEvent> {
    let msg = first_line(&entry.msg);
    let worker_id = worker_id_from_socket_path(entry.socket_path.as_deref());

    if entry.component == "ai.provider" {
        return Some(provider_failure_event(entry, worker_pids));
    }

    if let Some(captures) = STDERR_FORWARD.captures(&entry.msg) {
        let worker = captures.get(1).map_or("", |m| m.as_str());
        let body = captures.get(2).map_or("", |m| m.as_str());
        let body = classify_worker_stderr_body(worker, body, true)?;
        return Some(incident_event(
            entry,
            body.severity,
            IncidentCategory::Supervisor,
            body.event_class,
            body.subject,
            body.summary,
            body.tokens,
        ));
    }

    if SUPERVISOR_LISTENING.is_match(msg) {
        return Some(event(
            entry,
            IncidentSeverity::Info,
            IncidentCategory::Supervisor,
            "supervisor-start",
            daemon_subject(entry),
            "daemon supervisor listening",
        ));
    }
    if let Some(captures) = STARTUP_FAILED.captures(msg) {
        let err = captures.get(1).map_or("", |m| m.as_str());
        // TS tests the message case-insensitively
        // (/lock file is already being held/i): real log lines carry
        // "Lock file is already being held".
        if err
            .to_ascii_lowercase()
            .contains("lock file is already being held")
        {
            return Some(event(
                entry,
                IncidentSeverity::Warn,
                IncidentCategory::Supervisor,
                "supervisor-start",
                daemon_subject(entry),
                "supervisor startup blocked: another daemon holds the lock",
            ));
        }
        return Some(event(
            entry,
            IncidentSeverity::Error,
            IncidentCategory::Supervisor,
            "supervisor-start",
            daemon_subject(entry),
            format!(
                "supervisor startup failed: {}",
                truncate_text(error_message(first_line(err)), 100)
            ),
        ));
    }
    if let Some(captures) = SUPERVISOR_COMMAND.captures(msg) {
        let command = captures.get(1).map_or("", |m| m.as_str());
        let error = captures.get(2).map_or("", |m| m.as_str());
        let classified = classify_command_failure(command, error);
        return Some(incident_event(
            entry,
            classified.severity,
            IncidentCategory::Supervisor,
            classified.event_class,
            daemon_subject(entry),
            classified.summary,
            classified.tokens,
        ));
    }
    if let Some(captures) = DAEMON_COMMAND.captures(msg) {
        let command = captures.get(1).map_or("", |m| m.as_str());
        let error = captures.get(2).map_or("", |m| m.as_str());
        let classified = classify_command_failure(command, error);
        return Some(incident_event(
            entry,
            classified.severity,
            IncidentCategory::Supervisor,
            classified.event_class,
            worker_id.map_or_else(
                || "worker".to_string(),
                |worker_id| format!("worker {worker_id}"),
            ),
            classified.summary,
            // Keep the session ids/names classified out of the error, not
            // just the worker id.
            match worker_id {
                Some(worker_id) => {
                    let mut tokens = vec![worker_id.to_string()];
                    tokens.extend(classified.tokens);
                    tokens
                }
                None => classified.tokens,
            },
        ));
    }
    if let Some(captures) = CATCH_UP.captures(msg) {
        let session_id = captures.get(1).map(|m| m.as_str());
        let err = captures.get(2).map_or("", |m| m.as_str());
        let timed_out = err.contains("Timed out waiting for daemon worker response");
        return Some(incident_event(
            entry,
            if timed_out {
                IncidentSeverity::Error
            } else {
                IncidentSeverity::Warn
            },
            IncidentCategory::Supervisor,
            if timed_out {
                "timeout"
            } else {
                "command-failure"
            },
            session_id.map_or_else(
                || daemon_subject(entry),
                |session_id| format!("session {session_id}"),
            ),
            format!(
                "client catch-up failed{}: {}",
                session_id.map_or_else(String::new, |id| format!(" for session {id}")),
                truncate_text(error_message(first_line(err)), 100)
            ),
            session_id.map_or_else(Vec::new, |session_id| vec![session_id.to_string()]),
        ));
    }
    if let Some(captures) = HEARTBEATS_LIST.captures(msg) {
        let err = captures.get(1).map_or("", |m| m.as_str());
        let timed_out = err.contains("Timed out waiting for daemon worker response");
        return Some(event(
            entry,
            if timed_out {
                IncidentSeverity::Error
            } else {
                IncidentSeverity::Warn
            },
            IncidentCategory::Supervisor,
            if timed_out {
                "timeout"
            } else {
                "command-failure"
            },
            daemon_subject(entry),
            format!(
                "worker heartbeat list failed: {}",
                truncate_text(error_message(first_line(err)), 100)
            ),
        ));
    }

    if let Some(captures) = RECOVERED.captures(msg) {
        let worker = captures.get(1).map_or("", |m| m.as_str());
        let operations = captures.get(2).map_or("", |m| m.as_str());
        let (count, breakdown) = recovery_breakdown(operations);
        return Some(incident_event(
            entry,
            IncidentSeverity::Warn,
            IncidentCategory::Recovery,
            "recovery-replay",
            format!("worker {worker}"),
            format!(
                "worker {worker} recovered; {count} uncertain operation{} not replayed ({breakdown})",
                if count == 1 { "" } else { "s" }
            ),
            vec![worker.to_string()],
        ));
    }
    if let Some(captures) = RECOVERED_PLAIN.captures(msg) {
        let worker = captures.get(1).map_or("", |m| m.as_str());
        return Some(incident_event(
            entry,
            IncidentSeverity::Info,
            IncidentCategory::Recovery,
            "recovery-replay",
            format!("worker {worker}"),
            format!("worker {worker} recovered"),
            vec![worker.to_string()],
        ));
    }
    if let Some(captures) = ADOPT_FAILED.captures(msg) {
        let worker = captures.get(1).map_or("", |m| m.as_str());
        let err = captures.get(2).map_or("", |m| m.as_str());
        return Some(incident_event(
            entry,
            IncidentSeverity::Warn,
            IncidentCategory::Recovery,
            "recovery-failure",
            format!("worker {worker}"),
            format!(
                "could not adopt worker {worker}: {}",
                truncate_text(error_message(first_line(err)), 100)
            ),
            vec![worker.to_string()],
        ));
    }
    if let Some(captures) = RECOVER_FAILED.captures(msg) {
        let worker = captures.get(1).map_or("", |m| m.as_str());
        let err = captures.get(2).map_or("", |m| m.as_str());
        return Some(incident_event(
            entry,
            IncidentSeverity::Error,
            IncidentCategory::Recovery,
            "recovery-failure",
            format!("worker {worker}"),
            format!(
                "could not recover worker {worker}: {}",
                truncate_text(error_message(first_line(err)), 100)
            ),
            vec![worker.to_string()],
        ));
    }
    if let Some(captures) = FAILED_AFTER_RETRIES.captures(msg) {
        let worker = captures.get(1).map_or("", |m| m.as_str());
        return Some(incident_event(
            entry,
            IncidentSeverity::Error,
            IncidentCategory::Recovery,
            "recovery-failure",
            format!("worker {worker}"),
            format!("worker {worker} failed after three recovery attempts"),
            vec![worker.to_string()],
        ));
    }
    if let Some(captures) = UNRESPONSIVE.captures(msg) {
        let worker = captures.get(1).map_or("", |m| m.as_str());
        return Some(incident_event(
            entry,
            IncidentSeverity::Error,
            IncidentCategory::Recovery,
            "recovery-failure",
            format!("worker {worker}"),
            msg,
            vec![worker.to_string()],
        ));
    }
    if let Some(captures) = RECLAIMED.captures(msg) {
        let worker = captures.get(1).map_or("", |m| m.as_str());
        return Some(incident_event(
            entry,
            IncidentSeverity::Info,
            IncidentCategory::Recovery,
            "recovery-action",
            format!("worker {worker}"),
            format!("reclaimed stale registration for stopped worker {worker}"),
            vec![worker.to_string()],
        ));
    }
    if let Some(captures) = MIGRATED.captures(msg) {
        let jobs = captures.get(1).map_or("", |m| m.as_str());
        return Some(event(
            entry,
            IncidentSeverity::Info,
            IncidentCategory::Recovery,
            "recovery-action",
            daemon_subject(entry),
            format!("migrated {jobs} scheduled jobs into session artifacts"),
        ));
    }
    if REPLACEMENT.is_match(msg) {
        return Some(event(
            entry,
            IncidentSeverity::Info,
            IncidentCategory::Recovery,
            "recovery-action",
            daemon_subject(entry),
            msg,
        ));
    }
    if WOKE.is_match(msg) {
        // A scheduled wake is a supervisor lifecycle action, not crash
        // recovery.
        return Some(event(
            entry,
            IncidentSeverity::Info,
            IncidentCategory::Supervisor,
            "supervisor-action",
            daemon_subject(entry),
            msg,
        ));
    }

    if let Some(captures) = EVICTED_IDLE.captures(msg) {
        let worker = captures.get(1).map_or("", |m| m.as_str());
        let idle = captures.get(2).map_or("", |m| m.as_str());
        let sessions = captures.get(3).map_or("", |m| m.as_str());
        return Some(incident_event(
            entry,
            IncidentSeverity::Info,
            IncidentCategory::Supervisor,
            "worker-stop",
            format!("worker {worker}"),
            format!("evicted idle worker {worker} (idle {idle}m, {sessions} session(s))"),
            vec![worker.to_string()],
        ));
    }
    if let Some(captures) = EVICTED_EMPTY.captures(msg) {
        let worker = captures.get(1).map_or("", |m| m.as_str());
        return Some(incident_event(
            entry,
            IncidentSeverity::Info,
            IncidentCategory::Supervisor,
            "worker-stop",
            format!("worker {worker}"),
            format!("evicted empty session worker {worker} on last detach"),
            vec![worker.to_string()],
        ));
    }

    if entry.component == "coding-agent.daemon" {
        // The worker logs its own lifecycle lines; reusing the stderr-body
        // classifier gives them the same summaries as the supervisor's
        // stderr forward, so the duplicated log pair collapses in the
        // timeline.
        if let Some(worker_id) = worker_id {
            if let Some(body) = classify_worker_stderr_body(worker_id, msg, false) {
                return Some(incident_event(
                    entry,
                    body.severity,
                    IncidentCategory::Supervisor,
                    body.event_class,
                    body.subject,
                    body.summary,
                    body.tokens,
                ));
            }
        } else if CRASH_PREFIX.is_match(msg) {
            return Some(event(
                entry,
                IncidentSeverity::Critical,
                IncidentCategory::Supervisor,
                "worker-crash",
                "worker",
                format!("worker crashed: {}", truncate_text(msg, 100)),
            ));
        }
    }

    if entry.component == "coding-agent.daemon-supervisor"
        || entry.component == "coding-agent.daemon"
    {
        // Unknown diagnostics still matter during an incident; summarize
        // them.
        return Some(event(
            entry,
            if entry.level == "error" {
                IncidentSeverity::Error
            } else {
                IncidentSeverity::Warn
            },
            IncidentCategory::Supervisor,
            "diagnostic",
            worker_id.map_or_else(
                || daemon_subject(entry),
                |worker_id| format!("worker {worker_id}"),
            ),
            truncate_text(msg, SUMMARY_TRUNCATION),
        ));
    }
    None
}

/// Classify every entry, dropping the duplicate event the daemon writes
/// both to the structured log and to the worker stderr forward (same
/// summary, same second) (TS `collectIncidentEvents`).
pub fn collect_incident_events(
    entries: &[IncidentLogEntry],
    worker_pids: &WorkerPidMap,
) -> Vec<IncidentEvent> {
    let mut events: Vec<IncidentEvent> = Vec::new();
    let mut last_seen: HashMap<String, (i64, String)> = HashMap::new();
    for entry in entries {
        let Some(incident) = classify_incident_entry(entry, worker_pids) else {
            continue;
        };
        // The daemon writes the same lifecycle event both to the
        // structured log (coding-agent.daemon) and to the worker stderr
        // forward (coding-agent.daemon-supervisor); drop the second copy
        // when it lands within 2s. A repeat from the SAME component is a
        // real lifecycle transition — a worker restarted on its durable
        // id within 2s — and is never a duplicate.
        if lifecycle_classes().contains(incident.event_class.as_str()) {
            let key = format!("{}|{}", incident.category.as_str(), incident.summary);
            let previous = last_seen.get(&key);
            if let Some((previous_time_ms, previous_component)) = previous {
                if previous_component != &entry.component
                    && (incident.time_ms - previous_time_ms).abs() <= 2000
                {
                    continue;
                }
            }
            last_seen.insert(key, (incident.time_ms, entry.component.clone()));
        }
        events.push(incident);
    }
    events
}

#[cfg(test)]
#[path = "classify_tests.rs"]
mod tests;
