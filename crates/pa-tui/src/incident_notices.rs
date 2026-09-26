//! Daemon incident notices for the agents view (TS
//! `src/modes/agents-view/incident-notices.ts`).
//!
//! `prime-agent incident` (the classifier in `pa_types::incident`, the TS
//! `src/cli/incident.ts` port) already reconstructs daemon incidents from
//! the shared structured log (`~/.prime/agent/logs/agent.jsonl`); this
//! module reuses that classifier — never re-implementing it — to surface
//! a single collapsed, dismissible notice line in the agents-view header.
//! A notice appears when the recent window of the log contains a worker
//! crash, a command-timeout burst, or an update restart (a supervisor
//! replacement), so the operator sees the incident without running the
//! CLI by hand. On the initial read the view matches the CLI's
//! `[agent.jsonl.old, agent.jsonl]` source with the same bounded tail, so
//! incidents spanning a log rotation surface too.

use pa_types::incident::{
    collect_incident_events, collect_worker_pid_map, compute_incident_anomalies,
    latest_incident_stall_timeout_by_subject, parse_incident_log_line, IncidentEvent,
    IncidentLogEntry, IncidentSeverity,
};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Recent-log window, matching the `prime-agent incident` default (TS
/// `INCIDENT_NOTICE_WINDOW_MS`).
pub const INCIDENT_NOTICE_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

/// Initial tail bound: incidents older than the tail bytes are simply not
/// seen (TS `INCIDENT_NOTICE_TAIL_BYTES`).
pub const INCIDENT_NOTICE_TAIL_BYTES: u64 = 512 * 1024;

/// Retention cap for windowed entries: every entry keeps the full parsed
/// log record (fields), and agent.jsonl is the sink for ALL structured
/// logging with rotating generations, so a busy day would otherwise
/// retain unbounded memory and make every poll re-sort and re-classify
/// it all synchronously. Newest entries win; incidents older than the
/// cap are simply not seen — the same best-effort spirit as
/// [`INCIDENT_NOTICE_TAIL_BYTES`] (TS
/// `INCIDENT_NOTICE_MAX_WINDOW_ENTRIES`).
pub const INCIDENT_NOTICE_MAX_WINDOW_ENTRIES: usize = 20_000;

/// How often the agents view re-reads appended agent.jsonl bytes (TS
/// `INCIDENT_NOTICE_POLL_INTERVAL_MS`).
pub const INCIDENT_NOTICE_POLL_INTERVAL_MS: u64 = 30_000;

/// The pointer to the full timeline (TS `INCIDENT_NOTICE_POINTER`).
pub const INCIDENT_NOTICE_POINTER: &str = "— run prime-agent incident for the timeline";

const NEWLINE_BYTE: u8 = 0x0a;

/// The notice kinds worth surfacing (TS `IncidentNoticeKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum IncidentNoticeKind {
    WorkerCrash,
    TimeoutBurst,
    UpdateRestart,
}

impl IncidentNoticeKind {
    /// The dismissal-key prefix (TS `${kind}|`).
    pub fn key_prefix(self) -> &'static str {
        match self {
            IncidentNoticeKind::WorkerCrash => "worker-crash",
            IncidentNoticeKind::TimeoutBurst => "timeout-burst",
            IncidentNoticeKind::UpdateRestart => "update-restart",
        }
    }
}

/// One collapsed incident notice (TS `IncidentNotice`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncidentNotice {
    pub kind: IncidentNoticeKind,
    /// Dismissal key (`${kind}|${subject}`): incidents at or before the
    /// horizon stay hidden.
    pub key: String,
    pub severity: IncidentSeverity,
    pub subject: String,
    pub time_ms: i64,
    /// Sentence without the pointer suffix; the header renders the
    /// visible line.
    pub text: String,
}

/// Per-run incident notice state, cached on the agents view's flow (TS
/// `IncidentNoticeState` on `AgentsViewPersistentState`).
#[derive(Debug, Clone, Default)]
pub struct IncidentNoticeState {
    /// Windowed log entries parsed so far, oldest first.
    pub entries: Vec<IncidentLogEntry>,
    /// Byte offset consumed in agent.jsonl; `None` before the first tail
    /// read.
    pub log_offset: Option<u64>,
    /// `dev:ino` of agent.jsonl at the last read; a change means rotation
    /// or replacement.
    pub log_file_id: Option<String>,
    /// Dismissal horizons by notice key: incidents at or before this
    /// timeMs stay hidden.
    pub dismissed_horizons: HashMap<String, i64>,
    /// The collapsed notice currently worth showing, if any.
    pub notice: Option<IncidentNotice>,
}

impl IncidentNoticeState {
    /// A fresh state (TS `createIncidentNoticeState`).
    pub fn new() -> Self {
        Self::default()
    }
}

/// Local time of an incident, for "worker x crashed at 14:32" (TS
/// `formatIncidentNoticeTime`). A bare HH:MM only reads as today, so an
/// incident from another calendar day gets the date prefixed (the
/// tree-selector label-timestamp style): "9/14 23:10", or "26/9/14
/// 23:10" across a year boundary.
///
/// The TS reads the wall clock in the local timezone; the Rust tree is
/// UTC end-to-end (the daemon logs UTC and has no timezone layer), so
/// the Rust notice reads UTC.
pub fn format_incident_notice_time(time_ms: i64, now_ms: i64) -> String {
    let (time, then) = notice_parts(time_ms);
    let (_, now) = notice_parts(now_ms);
    if then.year == now.year && then.month == now.month && then.day == now.day {
        return time;
    }
    let (year, month, day) = (then.year, then.month, then.day);
    if then.year == now.year {
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

/// `(year, month, day)` for days since 1970-01-01 (Howard Hinnant's
/// `civil_from_days`).
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

/// Derive the notices worth surfacing from windowed agent.jsonl entries,
/// reusing the incident CLI's classifier (TS `deriveIncidentNotices`).
/// Exactly three incident classes qualify: worker crashes (any
/// worker-crash event), command-timeout bursts (the classifier's
/// per-subject "N command timeouts over X" anomaly), and update restarts
/// (a supervisor-start whose subject already started within the window,
/// i.e. the supervisor was replaced). A first-ever supervisor start is
/// routine and never produces a notice. A timeout-burst notice carries
/// the latest timeout of the stall cluster its anomaly describes — the
/// classifier anchors the anomaly at the cluster's first timeout — so
/// dismissing it records a horizon that only covers that burst as
/// dismissed: a later timeout extending the burst past the horizon
/// re-surfaces the notice, instead of it staying hidden until the first
/// timeout ages out of the window; an isolated stray timeout, or a
/// separate later stall, never moves the anchor and never re-opens it.
pub fn derive_incident_notices(entries: &[IncidentLogEntry], now_ms: i64) -> Vec<IncidentNotice> {
    let since_ms = now_ms - INCIDENT_NOTICE_WINDOW_MS;
    // CLI window parity: buildIncidentReport windows events by
    // [sinceMs, untilMs], so a future-dated entry (clock skew, a bogus
    // timestamp) is outside it too.
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
    // Latest timeout of each subject's stall cluster — the same incident
    // the classifier's per-subject "N command timeouts over X" anomaly
    // describes — so a notice and its dismissal horizon always refer to
    // one incident: dismissal advances with a growing burst (a later
    // timeout in the cluster re-surfaces the notice past the horizon
    // instead of it staying hidden until the first timeout ages out),
    // while a separate later stall or an isolated stray timeout never
    // moves the anchor.
    let latest_stall_timeout_by_subject = latest_incident_stall_timeout_by_subject(&events);
    for anomaly in compute_incident_anomalies(&events) {
        if anomaly.summary.contains("command timeouts") {
            // The anomaly summary already reads "<subject>: N command
            // timeouts over X".
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
    // The classifier also emits supervisor-start for failed spawns (lock
    // held, startup error) at warn/error severity; only a successful
    // start — the info-severity "listening on" event — counts toward a
    // replacement, or two failed spawns on one socket would read as a
    // restart.
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
/// most severe wins (critical > error > warn > info), the most recent
/// breaks ties. Repeated identical events aggregate here — the header
/// never stacks copies (TS `selectIncidentNotice`).
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

/// True when the notice sits at or before its key's dismissal horizon (TS
/// `isIncidentNoticeDismissed`).
pub fn is_incident_notice_dismissed(
    notice: &IncidentNotice,
    horizons: &HashMap<String, i64>,
) -> bool {
    horizons
        .get(&notice.key)
        .is_some_and(|horizon| notice.time_ms <= *horizon)
}

/// Dismiss the notice currently showing. Records its timeMs as the
/// horizon for its key, so the same incident (and any older incident on
/// that key) never re-renders on later polls or view re-entry, while a
/// newer qualifying incident does. Returns `false` when no notice is
/// showing (TS `dismissIncidentNoticeState`).
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

/// One rotation-safe incremental read of agent.jsonl (TS
/// `readIncidentLogLines`): the consumed lines, the next byte offset, and
/// the file identity.
#[derive(Debug, Clone, PartialEq, Eq)]
struct IncidentLogChunk {
    lines: Vec<String>,
    next_offset: u64,
    file_id: String,
}

/// Rotation-safe incremental read of agent.jsonl. Without a previous
/// offset — or after rotation (a changed inode), a shrink (recreation in
/// place), or more than one tail bound of new bytes — read the bounded
/// tail: the cut may begin mid-line (drop the torn leading fragment) or
/// exactly at a record boundary (the byte before the cut is a newline;
/// keep the intact first record, which dropping would silently lose for
/// the lifetime of the state). Otherwise read only appended bytes (every
/// read stays bounded). A trailing partial line is held back (the offset
/// stops at its newline), so a mid-write line parses only once complete,
/// on a later poll — unless `include_final_partial_line` is set for a
/// frozen file (the rotated .old), which no later poll can complete; its
/// final line is returned as-is. A missing or unreadable file returns
/// `None`; offsets beyond the file size are never re-processed.
fn read_incident_log_lines(
    log_path: &Path,
    previous_offset: Option<u64>,
    previous_file_id: Option<&str>,
    include_final_partial_line: bool,
) -> Option<IncidentLogChunk> {
    let mut file = std::fs::File::open(log_path).ok()?;
    let stats = file.metadata().ok()?;
    let file_id = file_identity(&stats);
    let rotated = previous_file_id.is_some_and(|id| id != file_id);
    // Re-tail when nothing was read yet, after a rotation (a new file),
    // when the file shrank (recreated in place), or when more than one
    // tail bound appended since the last poll; every read stays bounded
    // and offsets are never re-processed.
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
        // The bounded tail may begin mid-line (the cut split a record:
        // drop the torn leading fragment) or exactly at a record boundary
        // (the byte before the cut is a newline: the first line in the
        // buffer is a complete record, and dropping it would silently
        // lose a qualifying incident for the lifetime of the state).
        // Read that one byte to tell the cases apart; the read happens
        // only on this bounded re-tail path.
        let mut preceding = [0u8; 1];
        let begins_mid_line = read(&mut preceding, start - 1)? != 1 || preceding[0] != NEWLINE_BYTE;
        if begins_mid_line {
            // A chunk with no newline at all is one mid-write line: hold
            // it back so the completed line is still parsed by the next
            // poll.
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
    // A frozen file (the rotated .old) never gets the completing write,
    // so with include_final_partial_line its final line is returned
    // as-is: a torn line parses to None and drops harmlessly, while a
    // complete record missing only its newline must not be lost.
    if !include_final_partial_line && end > 0 && buffer[end - 1] != NEWLINE_BYTE {
        // Hold back the partially-written final line until it completes.
        let last_newline = buffer[..bytes_read]
            .iter()
            .rposition(|byte| *byte == NEWLINE_BYTE);
        match last_newline {
            Some(last_newline) if last_newline >= line_start => {
                end = last_newline + 1;
            }
            _ => {
                return Some(IncidentLogChunk {
                    lines: Vec::new(),
                    next_offset: start,
                    file_id,
                });
            }
        }
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
/// changes the inode); the TS `stats.dev}:${stats.ino}` shape. The
/// non-Unix fallback keys on size + mtime, the stabilities available
/// without a stat API there.
#[cfg(unix)]
fn file_identity(stats: &std::fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    format!("{}:{}", stats.dev(), stats.ino())
}

#[cfg(not(unix))]
fn file_identity(stats: &std::fs::Metadata) -> String {
    let mtime = stats
        .modified()
        .ok()
        .and_then(|mtime| mtime.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("{}:{mtime}", stats.len())
}

/// Keep windowed entries in stable time order across polls: new entries
/// append, everything older than the window drops, and only the newest
/// [`INCIDENT_NOTICE_MAX_WINDOW_ENTRIES`] survive, so memory and per-poll
/// work stay bounded (TS `mergeIncidentWindowedEntries`). Lines re-read
/// after a rotation or a re-tail collapse harmlessly — identical
/// lifecycle events dedupe in the classifier, and the collapsed line
/// never stacks copies.
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

/// One best-effort poll: read new agent.jsonl bytes, keep the 24h window,
/// re-derive the qualifying notices, apply the dismissal horizons, and
/// keep the single collapsed line worth showing. The first successful
/// read also tails the rotated agent.jsonl.old — matching the CLI's
/// `[agent.jsonl.old, agent.jsonl]` source with the same bounded tail —
/// so incidents spanning a rotation still surface in a fresh view. Later
/// polls read only appended agent.jsonl bytes, except when the live read
/// detects a new generation: the un-consumed tail of the rotated-out one
/// is then completed from .old by offset continuation (never re-read from
/// its start, which would duplicate supervisor starts into phantom update
/// restarts). Returns `true` when the collapsed line changed so the
/// caller can re-render. Never throws for a missing or unreadable log:
/// that poll keeps the consumed offset (a re-tail would fabricate
/// restarts) but still re-derives, so the notice expires with its window
/// instead of surviving forever while the log stays unreadable (TS
/// `refreshIncidentNoticeState`).
pub fn refresh_incident_notice_state(
    state: &mut IncidentNoticeState,
    log_path: &Path,
    now_ms: i64,
) -> bool {
    // The first successful read bridges the rotated generation: the CLI
    // reads [agent.jsonl.old, agent.jsonl], so a view opened after a
    // rotation must see pairs that span it — an update restart whose
    // earlier supervisor start sits in .old, or a burst straddling the
    // files. A later re-read from .old's start would duplicate
    // supervisor-start lines into a phantom update restart (the
    // classifier does not dedupe supervisor-start), which is also why
    // the consumed offset never resets.
    let first_read = state.log_offset.is_none() && state.log_file_id.is_none();
    let chunk = read_incident_log_lines(
        log_path,
        state.log_offset,
        state.log_file_id.as_deref(),
        false,
    );
    let since_ms = now_ms - INCIDENT_NOTICE_WINDOW_MS;
    // CLI window parity (buildIncidentReport bounds events by >= since
    // && <= until): future-dated entries fall outside the window and
    // never surface.
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
        // Tail the rotated .old with the same bounded tail as the main
        // log: the CLI reads the same [agent.jsonl.old, agent.jsonl]
        // pair, and the merge below sorts by time, so the read order
        // here does not matter.
        if first_read {
            // The rotated .old is frozen: include its final line even
            // without a trailing newline — no later poll will ever
            // complete it.
            let rotated = read_incident_log_lines(&rotated_path(log_path), None, None, true);
            // A rename rotation can land between the live read above and
            // this one: the .old path then names the very file the chunk
            // just consumed, and re-parsing it would double supervisor
            // starts into a phantom update restart (the classifier does
            // not dedupe supervisor-start) and double timeout counts.
            // Bridge only a genuinely different generation.
            if let Some(rotated) = rotated.filter(|rotated| rotated.file_id != chunk_id) {
                parsed = parse_windowed_lines(&rotated.lines);
            }
        } else if state
            .log_file_id
            .as_deref()
            .is_some_and(|previous_id| chunk_id != previous_id)
        {
            // A rotation between polls strands the un-consumed tail of
            // the previous generation at the .old path: no later poll
            // re-reads it, so a crash logged in that gap would surface in
            // `prime-agent incident` but never in the notice. The live
            // read just detected the new generation, so continue the old
            // one from its consumed offset — the file id still matches,
            // the read is an offset continuation, and no consumed line is
            // re-parsed (a re-tail on an id mismatch stays bounded).
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
        state.log_file_id = Some(chunk_id);
    }
    // A missing or unreadable log keeps the consumed offset and file id
    // exactly as they are: resetting them would make the next poll
    // re-tail and re-parse consumed lines into a phantom second
    // supervisor start (a false update restart; the classifier does not
    // dedupe supervisor-start) and doubled timeout counts. The poll still
    // falls through to the merge/derive path with no new entries, so the
    // notice ages out of its window while the log stays unreadable
    // instead of surviving forever; a real rotation is still caught by
    // the file id changing (or the offset passing the size) on the next
    // successful read.
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

/// `<log_path>.old`, the rotated generation (TS `` `${logPath}.old` ``).
fn rotated_path(log_path: &Path) -> std::path::PathBuf {
    std::path::PathBuf::from(format!("{}.old", log_path.display()))
}

#[cfg(test)]
#[path = "incident_notice_tests.rs"]
mod tests;
