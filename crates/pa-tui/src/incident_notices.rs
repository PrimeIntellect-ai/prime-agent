//! Daemon incident notices for the agents view: reuse the `prime-agent
//! incident` classifier (`pa_types::incident`) to surface one collapsed,
//! dismissible notice line (worker crash, command-timeout burst, or an
//! update restart).

use pa_types::incident::{
    collect_incident_events, collect_worker_pid_map, compute_incident_anomalies,
    latest_incident_stall_timeout_by_subject, parse_incident_log_line, IncidentEvent,
    IncidentLogEntry, IncidentSeverity,
};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Recent-log window, matching the `prime-agent incident` default.
pub const INCIDENT_NOTICE_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

/// Initial tail bound: incidents older than the tail bytes are simply not seen.
pub const INCIDENT_NOTICE_TAIL_BYTES: u64 = 512 * 1024;

/// Retention cap for windowed entries: every entry keeps the full parsed
/// record, so a busy day would otherwise retain unbounded memory.
pub const INCIDENT_NOTICE_MAX_WINDOW_ENTRIES: usize = 20_000;

pub const INCIDENT_NOTICE_POLL_INTERVAL_MS: u64 = 30_000;

/// The pointer to the full timeline.
pub const INCIDENT_NOTICE_POINTER: &str = "— run prime-agent incident for the timeline";

const NEWLINE_BYTE: u8 = 0x0a;

/// The notice kinds worth surfacing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum IncidentNoticeKind {
    WorkerCrash,
    TimeoutBurst,
    UpdateRestart,
}

impl IncidentNoticeKind {
    #[must_use]
    pub fn key_prefix(self) -> &'static str {
        match self {
            IncidentNoticeKind::WorkerCrash => "worker-crash",
            IncidentNoticeKind::TimeoutBurst => "timeout-burst",
            IncidentNoticeKind::UpdateRestart => "update-restart",
        }
    }
}

/// One collapsed incident notice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncidentNotice {
    pub kind: IncidentNoticeKind,
    /// Dismissal key (`${kind}|${subject}`): incidents at or before the horizon stay hidden.
    pub key: String,
    pub severity: IncidentSeverity,
    pub subject: String,
    pub time_ms: i64,
    pub text: String,
}

/// Per-run incident notice state, cached on the agents view's flow.
#[derive(Debug, Clone, Default)]
pub struct IncidentNoticeState {
    /// Windowed log entries parsed so far, oldest first.
    pub entries: Vec<IncidentLogEntry>,
    /// Byte offset consumed in agent.jsonl; `None` before the first tail read.
    pub log_offset: Option<u64>,
    /// `dev:ino` of agent.jsonl at the last read; a change means rotation or replacement.
    pub log_file_id: Option<String>,
    /// Dismissal horizons by notice key: incidents at or before this timeMs stay hidden.
    pub dismissed_horizons: HashMap<String, i64>,
    /// The collapsed notice currently worth showing, if any.
    pub notice: Option<IncidentNotice>,
}

impl IncidentNoticeState {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

/// Local time of an incident ("worker x crashed at 14:32"; an incident from
/// another calendar day gets the date prefixed). Divergence from TS: the
/// Rust tree is UTC end-to-end, so the notice reads UTC.
#[must_use]
pub fn format_incident_notice_time(time_ms: i64, now_ms: i64) -> String {
    let (time, (year, month, day)) = notice_parts(time_ms);
    let (_, (now_year, now_month, now_day)) = notice_parts(now_ms);
    if year == now_year && month == now_month && day == now_day {
        return time;
    }
    if year == now_year {
        return format!("{month}/{day} {time}");
    }
    format!("{}/{month}/{day} {time}", year % 100)
}

/// `(HH:MM, date parts)` of an instant, UTC.
fn notice_parts(ms: i64) -> (String, (i64, u32, u32)) {
    let days = ms.div_euclid(86_400_000);
    let secs_of_day = ms.rem_euclid(86_400_000) / 1_000;
    let (year, month, day) = civil_from_days(days);
    (
        format!("{:02}:{:02}", secs_of_day / 3_600, secs_of_day / 60 % 60),
        (year, month, day),
    )
}

/// `(year, month, day)` for days since 1970-01-01 (Howard Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    (year, month as u32, day as u32)
}

fn create_notice(
    kind: IncidentNoticeKind,
    severity: IncidentSeverity,
    subject: &str,
    time_ms: i64,
    text: String,
) -> IncidentNotice {
    IncidentNotice {
        kind,
        key: format!("{}|{subject}", kind.key_prefix()),
        severity,
        subject: subject.to_string(),
        time_ms,
        text,
    }
}

/// Three classes qualify: worker crashes, command-timeout bursts, and
/// update restarts (a supervisor start whose subject already started within
/// the window; a first-ever start is routine). A timeout-burst notice
/// carries the latest timeout of its stall cluster, so its dismissal
/// horizon covers only that burst.
#[must_use]
pub fn derive_incident_notices(entries: &[IncidentLogEntry], now_ms: i64) -> Vec<IncidentNotice> {
    let since_ms = now_ms - INCIDENT_NOTICE_WINDOW_MS;
    // CLI window parity: buildIncidentReport windows events by [sinceMs, untilMs], so a
    // future-dated entry (clock skew) is outside it too.
    let windowed: Vec<IncidentLogEntry> = entries
        .iter()
        .filter(|entry| entry.time_ms >= since_ms && entry.time_ms <= now_ms)
        .cloned()
        .collect();
    let worker_pids = collect_worker_pid_map(&windowed);
    let mut events = collect_incident_events(&windowed, &worker_pids);
    events.sort_by_key(|event: &IncidentEvent| event.time_ms);
    let mut notices: Vec<IncidentNotice> = Vec::new();
    for event in &events {
        if event.event_class == "worker-crash" {
            // The subject already reads "worker <id>" ("worker" when the
            // id is unknown).
            notices.push(create_notice(
                IncidentNoticeKind::WorkerCrash,
                event.severity,
                &event.subject,
                event.time_ms,
                format!(
                    "{} crashed at {}",
                    event.subject,
                    format_incident_notice_time(event.time_ms, now_ms)
                ),
            ));
        }
    }
    // Latest timeout of each subject's stall cluster — so a notice and its dismissal horizon refer
    // to one incident.
    let latest_stall_timeout_by_subject = latest_incident_stall_timeout_by_subject(&events);
    for anomaly in compute_incident_anomalies(&events) {
        if anomaly.summary.contains("command timeouts") {
            // The anomaly summary already reads "<subject>: N command timeouts over X".
            let latest_timeout_ms = latest_stall_timeout_by_subject
                .get(&anomaly.subject)
                .copied()
                .unwrap_or(anomaly.time_ms);
            notices.push(create_notice(
                IncidentNoticeKind::TimeoutBurst,
                anomaly.severity,
                &anomaly.subject,
                latest_timeout_ms,
                anomaly.summary,
            ));
        }
    }
    // Only a successful start (the info-severity "listening on" event) counts
    // toward a replacement — the classifier also emits supervisor-start for
    // failed spawns, which would read as a restart.
    let mut started_subjects: Vec<&str> = Vec::new();
    for event in &events {
        if event.event_class != "supervisor-start" || event.severity != IncidentSeverity::Info {
            continue;
        }
        if started_subjects.contains(&event.subject.as_str()) {
            notices.push(create_notice(
                IncidentNoticeKind::UpdateRestart,
                event.severity,
                &event.subject,
                event.time_ms,
                format!(
                    "daemon restarted for update at {}",
                    format_incident_notice_time(event.time_ms, now_ms)
                ),
            ));
        } else {
            started_subjects.push(&event.subject);
        }
    }
    notices
}

/// Collapse the derived notices to the single line the header shows: the
/// most severe wins, the most recent breaks ties, repeated identical
/// events aggregate.
#[must_use]
pub fn select_incident_notice(notices: &[IncidentNotice]) -> Option<IncidentNotice> {
    let mut best: Option<&IncidentNotice> = None;
    for notice in notices {
        let better = best.is_none_or(|best| {
            notice.severity.rank() > best.severity.rank()
                || (notice.severity.rank() == best.severity.rank() && notice.time_ms > best.time_ms)
        });
        if better {
            best = Some(notice);
        }
    }
    best.cloned()
}

/// True when the notice sits at or before its key's dismissal horizon.
#[must_use]
pub fn is_incident_notice_dismissed<S: std::hash::BuildHasher + Default>(
    notice: &IncidentNotice,
    horizons: &HashMap<String, i64, S>,
) -> bool {
    horizons
        .get(&notice.key)
        .is_some_and(|horizon| notice.time_ms <= *horizon)
}

/// Dismiss the notice currently showing: records its timeMs as the
/// horizon for its key, so the same incident never re-renders while a
/// newer one does.
pub fn dismiss_incident_notice_state(state: &mut IncidentNoticeState) -> bool {
    let Some(notice) = state.notice.clone() else {
        return false;
    };
    let horizon = state
        .dismissed_horizons
        .get(&notice.key)
        .copied()
        .unwrap_or(0)
        .max(notice.time_ms);
    state.dismissed_horizons.insert(notice.key, horizon);
    state.notice = None;
    true
}

fn same_incident_notice(a: Option<&IncidentNotice>, b: Option<&IncidentNotice>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a.key == b.key && a.time_ms == b.time_ms && a.text == b.text,
        (None, None) => true,
        _ => false,
    }
}

/// One rotation-safe incremental read of agent.jsonl.
#[derive(Debug, Clone, PartialEq, Eq)]
struct IncidentLogChunk {
    lines: Vec<String>,
    next_offset: u64,
    /// `None` where the platform keeps no stable file identity: the caller
    /// treats the log as never-rotated on identity and leans on the
    /// offset-past-size check.
    file_id: Option<String>,
}

/// Rotation-safe incremental read: read the bounded tail on a first read,
/// a rotation, a shrink, or more than one tail bound of new bytes;
/// otherwise read only appended bytes. A trailing partial line is held
/// back until it completes, unless `include_final_partial_line` is set
/// for a frozen file. Returns `None` for a missing or unreadable file.
fn read_incident_log_lines(
    log_path: &Path,
    previous_offset: Option<u64>,
    previous_file_id: Option<&str>,
    include_final_partial_line: bool,
) -> Option<IncidentLogChunk> {
    let mut file = std::fs::File::open(log_path).ok()?;
    let stats = file.metadata().ok()?;
    let file_id = file_identity(&stats);
    let rotated =
        previous_file_id.is_some_and(|id| file_id.as_deref().is_some_and(|current| current != id));
    let retailed = previous_offset.is_none()
        || rotated
        || previous_offset.is_some_and(|offset| offset > stats.len())
        || stats.len() - previous_offset.unwrap_or(0) > INCIDENT_NOTICE_TAIL_BYTES;
    let start = if retailed {
        stats.len().saturating_sub(INCIDENT_NOTICE_TAIL_BYTES)
    } else {
        previous_offset.unwrap_or(0)
    };
    if start >= stats.len() {
        return Some(IncidentLogChunk {
            lines: Vec::new(),
            next_offset: stats.len(),
            file_id,
        });
    }
    let mut buffer = vec![0u8; (stats.len() - start) as usize];
    let mut read = move |buffer: &mut [u8], offset: u64| -> Option<usize> {
        file.seek(SeekFrom::Start(offset)).ok()?;
        let mut filled = 0;
        while filled < buffer.len() {
            match file.read(&mut buffer[filled..]) {
                Ok(0) => break,
                Ok(n) => filled += n,
                Err(_) => return None,
            }
        }
        Some(filled)
    };
    let bytes_read = read(&mut buffer, start)?;
    let mut line_start = 0usize;
    if retailed && start > 0 {
        // The bounded tail may begin mid-line (drop the torn leading fragment)
        // or exactly at a record boundary (the first line is a complete record,
        // and dropping it would silently lose a qualifying incident); read that
        // one byte to tell the cases apart.
        let mut preceding = [0u8; 1];
        let begins_mid_line = read(&mut preceding, start - 1)? != 1 || preceding[0] != NEWLINE_BYTE;
        if begins_mid_line {
            // A chunk with no newline at all is one mid-write line: hold it back for the next poll.
            let Some(first_newline) = buffer[..bytes_read]
                .iter()
                .position(|byte| *byte == NEWLINE_BYTE)
            else {
                return Some(IncidentLogChunk {
                    lines: Vec::new(),
                    next_offset: start,
                    file_id,
                });
            };
            line_start = first_newline + 1;
        }
    }
    let mut end = bytes_read;
    // A frozen file (the rotated .old) never gets the completing write, so with
    // include_final_partial_line its final line is returned as-is.
    if !include_final_partial_line && end > 0 && buffer[end - 1] != NEWLINE_BYTE {
        // Hold back the partially-written final line until it completes.
        let last_newline = buffer[..bytes_read]
            .iter()
            .rposition(|byte| *byte == NEWLINE_BYTE);
        let Some(last_newline) = last_newline.filter(|newline| *newline >= line_start) else {
            return Some(IncidentLogChunk {
                lines: Vec::new(),
                next_offset: start,
                file_id,
            });
        };
        end = last_newline + 1;
    }
    let lines: Vec<String> = String::from_utf8_lossy(&buffer[line_start..end])
        .split('\n')
        .filter(|line| !line.trim().is_empty())
        .map(str::to_string)
        .collect();
    Some(IncidentLogChunk {
        lines,
        next_offset: start + end as u64,
        file_id,
    })
}

/// The filesystem identity of the log: `dev:ino` on Unix (a rotation
/// changes the inode). Rust's std has no dev/ino on other platforms, and
/// keying on size + mtime instead would flip the identity on every append
/// — re-tailing consumed bytes into phantom update restarts.
#[cfg(unix)]
fn file_identity(stats: &std::fs::Metadata) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    Some(format!("{}:{}", stats.dev(), stats.ino()))
}

#[cfg(not(unix))]
fn file_identity(_stats: &std::fs::Metadata) -> Option<String> {
    None
}

/// Keep windowed entries in stable time order across polls: new entries
/// append, older-than-window drops, only the newest
/// [`INCIDENT_NOTICE_MAX_WINDOW_ENTRIES`] survive.
fn merge_incident_windowed_entries(
    entries: &[IncidentLogEntry],
    parsed: &[IncidentLogEntry],
    since_ms: i64,
) -> Vec<IncidentLogEntry> {
    if entries.is_empty() && parsed.is_empty() {
        return Vec::new();
    }
    let mut merged: Vec<IncidentLogEntry> = entries.iter().chain(parsed.iter()).cloned().collect();
    merged.sort_by_key(|entry| entry.time_ms);
    let mut windowed: Vec<IncidentLogEntry> = merged
        .into_iter()
        .filter(|entry| entry.time_ms >= since_ms)
        .collect();
    if windowed.len() > INCIDENT_NOTICE_MAX_WINDOW_ENTRIES {
        let excess = windowed.len() - INCIDENT_NOTICE_MAX_WINDOW_ENTRIES;
        windowed.drain(..excess);
    }
    windowed
}

/// One best-effort poll of the windowed notices. Returns `true` when
/// the collapsed line changed. Never throws for a missing or unreadable
/// log: that poll keeps the consumed offset (a re-tail would fabricate
/// restarts) but still re-derives, so the notice expires with its
/// window.
pub fn refresh_incident_notice_state(
    state: &mut IncidentNoticeState,
    log_path: &Path,
    now_ms: i64,
) -> bool {
    // The first successful read bridges the rotated generation (the CLI's
    // [agent.jsonl.old, agent.jsonl] pair); a re-read from .old's start would
    // duplicate supervisor starts into a phantom update restart, which is why
    // the consumed offset never resets.
    let first_read = state.log_offset.is_none() && state.log_file_id.is_none();
    let chunk = read_incident_log_lines(
        log_path,
        state.log_offset,
        state.log_file_id.as_deref(),
        false,
    );
    let since_ms = now_ms - INCIDENT_NOTICE_WINDOW_MS;
    let parse_windowed_lines = |lines: &[String]| -> Vec<IncidentLogEntry> {
        lines
            .iter()
            .filter_map(|line| parse_incident_log_line(line))
            .filter(|entry| entry.time_ms >= since_ms && entry.time_ms <= now_ms)
            .collect()
    };
    let mut parsed: Vec<IncidentLogEntry> = Vec::new();
    if let Some(chunk) = chunk {
        let chunk_id = chunk.file_id.clone();
        // Tail the rotated .old with the same bounded tail as the main log; the merge below sorts
        // by time.
        if first_read {
            // The rotated .old is frozen: include its final line even without a trailing newline.
            let rotated = read_incident_log_lines(&rotated_path(log_path), None, None, true);
            // A rename rotation can land between the live read and this one:
            // re-parsing the just-consumed file would double supervisor starts into a
            // phantom restart. Bridge only a genuinely different generation.
            if let Some(rotated) = rotated.filter(|rotated| rotated.file_id != chunk_id) {
                parsed = parse_windowed_lines(&rotated.lines);
            }
        } else if state
            .log_file_id
            .as_ref()
            .is_some_and(|previous_id| chunk_id.as_ref() != Some(previous_id))
        {
            // A rotation between polls strands the un-consumed tail of the previous
            // generation at the .old path; continue it from its consumed offset (no
            // consumed line is re-parsed).
            let rotated_tail = read_incident_log_lines(
                &rotated_path(log_path),
                state.log_offset,
                state.log_file_id.as_deref(),
                true,
            );
            if let Some(rotated_tail) = rotated_tail {
                parsed = parse_windowed_lines(&rotated_tail.lines);
            }
        }
        parsed.extend(parse_windowed_lines(&chunk.lines));
        state.log_offset = Some(chunk.next_offset);
        state.log_file_id = chunk_id;
    }
    // A missing or unreadable log keeps the consumed offset and file id; a
    // real rotation is still caught when the file id changes on a later read.
    let previous = state.notice.clone();
    state.entries = merge_incident_windowed_entries(&state.entries, &parsed, since_ms);
    let notices = derive_incident_notices(&state.entries, now_ms);
    state.notice = select_incident_notice(
        &notices
            .iter()
            .filter(|notice| !is_incident_notice_dismissed(notice, &state.dismissed_horizons))
            .cloned()
            .collect::<Vec<_>>(),
    );
    !same_incident_notice(previous.as_ref(), state.notice.as_ref())
}

/// `<log_path>.old`, the rotated generation.
fn rotated_path(log_path: &Path) -> std::path::PathBuf {
    std::path::PathBuf::from(format!("{}.old", log_path.display()))
}

#[cfg(test)]
#[path = "incident_notice_tests.rs"]
mod tests;
