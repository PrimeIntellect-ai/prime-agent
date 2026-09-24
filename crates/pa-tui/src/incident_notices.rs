//! Daemon incident notices for the agents view, ported from TS
//! `modes/agents-view/incident-notices.ts` (TS PR #2406) and reusing this
//! crate's incident classifier — never re-implementing it. The view polls
//! the live daemon log (the newest per-daemon log; rust has no shared
//! structured `agent.jsonl`) on a bounded, rotation-safe incremental read,
//! and surfaces one collapsed, dismissible warning line when the recent
//! window holds a worker crash, a command-timeout burst, or a supervisor
//! replacement (an update restart), pointing at `prime-agent incident` for
//! the full timeline.
//!
//! The agents-view wiring (the poll timer, the header line, the Esc
//! dismissal) lands with the `incident-enrichment` follow-up lane; this
//! module carries the whole state machine so that lane is pure wiring.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use pa_types::daemon::SocketIdentity;

use crate::incident::{
    collect_incident_events, compute_incident_anomalies, latest_stall_timeout_by_subject,
    IncidentCategory, IncidentEvent, IncidentEventClass, IncidentLogEntry, IncidentSeverity,
};

/// Recent-log window, matching the `prime-agent incident` default.
pub const INCIDENT_NOTICE_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;
/// Initial tail bound: incidents older than the tail bytes are simply not
/// seen (the TS `INCIDENT_NOTICE_TAIL_BYTES`).
pub const INCIDENT_NOTICE_TAIL_BYTES: u64 = 512 * 1024;
/// Retention cap for windowed entries: newest entries win, so memory and
/// per-poll work stay bounded on a busy log (the TS
/// `INCIDENT_NOTICE_MAX_WINDOW_ENTRIES`).
pub const INCIDENT_NOTICE_MAX_WINDOW_ENTRIES: usize = 20_000;
/// How often the agents view re-reads appended log bytes (the TS
/// `INCIDENT_NOTICE_POLL_INTERVAL_MS`).
pub const INCIDENT_NOTICE_POLL_INTERVAL_MS: u64 = 30_000;

/// The suffix pointing the operator at the CLI (the TS
/// `INCIDENT_NOTICE_POINTER`).
pub const INCIDENT_NOTICE_POINTER: &str = "\u{2014} run prime-agent incident for the timeline";

const NEWLINE_BYTE: u8 = b'\n';

/// The three incident classes worth a header line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IncidentNoticeKind {
    WorkerCrash,
    TimeoutBurst,
    UpdateRestart,
}

impl IncidentNoticeKind {
    fn as_str(self) -> &'static str {
        match self {
            IncidentNoticeKind::WorkerCrash => "worker-crash",
            IncidentNoticeKind::TimeoutBurst => "timeout-burst",
            IncidentNoticeKind::UpdateRestart => "update-restart",
        }
    }
}

/// One derived notice. `time_ms` is the dismissal anchor: incidents at or
/// before the recorded horizon for the key stay hidden.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncidentNotice {
    pub kind: IncidentNoticeKind,
    /// `${kind}|${subject}`: the dismissal key.
    pub key: String,
    pub severity: IncidentSeverity,
    pub subject: String,
    pub time_ms: i64,
    /// The sentence without the pointer suffix.
    pub text: String,
}

/// Per-run incident notice state, carried across view re-entries (the TS
/// persistentState slot).
#[derive(Debug, Default)]
pub struct IncidentNoticeState {
    /// Windowed log entries parsed so far, oldest first.
    pub entries: Vec<IncidentLogEntry>,
    /// Byte offset consumed in the live log; `None` before the first read.
    pub log_offset: Option<u64>,
    /// The log file's identity at the last read; a change means rotation.
    pub log_file_id: Option<SocketIdentity>,
    /// Dismissal horizons by notice key.
    pub dismissed_horizons: HashMap<String, i64>,
    /// The collapsed notice currently worth showing, if any.
    pub notice: Option<IncidentNotice>,
}

impl IncidentNoticeState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// The notice time label: `HH:MM` on the same calendar day, `M/D HH:MM`
/// within the year, `YY/M/D HH:MM` otherwise. The daemon logs UTC (and the
/// report the pointer cites is UTC), so the label is UTC — the rust TUI has
/// no local-time facility (the TS notice reads the wall clock).
pub fn format_incident_notice_time(time_ms: i64, now_ms: i64) -> String {
    let (year, month, day, hour, minute, _) = crate::incident::civil_from_ms(time_ms);
    let (now_year, now_month, now_day, _, _, _) = crate::incident::civil_from_ms(now_ms);
    let time = format!("{hour:02}:{minute:02}");
    if year == now_year && month == now_month && day == now_day {
        return time;
    }
    if year == now_year {
        format!("{month}/{day} {time}")
    } else {
        format!("{}/{month}/{day} {time}", year % 100)
    }
}

/// The styled one-line notice rendered in the agents-view header (the TS
/// `formatIncidentNoticeLine`).
pub fn format_incident_notice_line(notice: &IncidentNotice) -> String {
    format!(
        "\x1b[33m\u{26a0} {} {INCIDENT_NOTICE_POINTER}\x1b[39m",
        notice.text
    )
}

fn create_notice(
    kind: IncidentNoticeKind,
    severity: IncidentSeverity,
    subject: String,
    time_ms: i64,
    text: String,
) -> IncidentNotice {
    IncidentNotice {
        kind,
        key: format!("{}|{subject}", kind.as_str()),
        severity,
        subject,
        time_ms,
        text,
    }
}

/// Derive the notices worth surfacing from windowed log entries, reusing
/// the incident classifier (the TS `deriveIncidentNotices`). Exactly three
/// incident classes qualify: worker crashes (any worker-crash event),
/// command-timeout bursts (the classifier's per-subject "N command
/// timeouts" anomaly), and supervisor replacements (an update exit — the
/// supervisor left intending the update to relaunch it). The timeout-burst
/// notice carries the latest timeout of the stall cluster its anomaly
/// describes, so dismissing it records a horizon that only covers that
/// burst: a later timeout extending the burst re-surfaces the notice, while
/// a separate later stall never re-opens it.
pub fn derive_incident_notices(entries: &[IncidentLogEntry], now_ms: i64) -> Vec<IncidentNotice> {
    let since_ms = now_ms - INCIDENT_NOTICE_WINDOW_MS;
    let windowed: Vec<IncidentLogEntry> = entries
        .iter()
        .filter(|entry| entry.time_ms >= since_ms && entry.time_ms <= now_ms)
        .cloned()
        .collect();
    let mut events: Vec<IncidentEvent> = collect_incident_events(&windowed);
    events.sort_by_key(|event| event.time_ms);

    let mut notices: Vec<IncidentNotice> = Vec::new();
    for event in &events {
        if event.event_class == IncidentEventClass::WorkerCrash {
            notices.push(create_notice(
                IncidentNoticeKind::WorkerCrash,
                event.severity,
                event.subject.clone(),
                event.time_ms,
                format!(
                    "{} crashed at {}",
                    event.subject,
                    format_incident_notice_time(event.time_ms, now_ms)
                ),
            ));
        }
    }

    let latest_stall = latest_stall_timeout_by_subject(&events);
    let classified: Vec<IncidentEvent> = events
        .iter()
        .filter(|event| event.category != IncidentCategory::Anomaly)
        .cloned()
        .collect();
    for anomaly in compute_incident_anomalies(&classified) {
        if anomaly.summary.contains("command timeouts") {
            let latest_timeout_ms = latest_stall
                .get(&anomaly.subject)
                .copied()
                .unwrap_or(anomaly.time_ms);
            notices.push(create_notice(
                IncidentNoticeKind::TimeoutBurst,
                anomaly.severity,
                anomaly.subject.clone(),
                latest_timeout_ms,
                anomaly.summary.clone(),
            ));
        }
    }

    for event in &events {
        if event.event_class == IncidentEventClass::SupervisorRestart {
            notices.push(create_notice(
                IncidentNoticeKind::UpdateRestart,
                event.severity,
                event.subject.clone(),
                event.time_ms,
                format!(
                    "{} at {}",
                    event.summary,
                    format_incident_notice_time(event.time_ms, now_ms)
                ),
            ));
        }
    }
    notices
}

/// Collapse the derived notices to the single line the header shows: the
/// most severe wins, the most recent breaks ties (the TS
/// `selectIncidentNotice`).
pub fn select_incident_notice(notices: &[IncidentNotice]) -> Option<IncidentNotice> {
    let mut best: Option<&IncidentNotice> = None;
    for notice in notices {
        best = match best {
            None => Some(notice),
            Some(best_notice) => {
                if notice.severity > best_notice.severity
                    || (notice.severity == best_notice.severity
                        && notice.time_ms > best_notice.time_ms)
                {
                    Some(notice)
                } else {
                    Some(best_notice)
                }
            }
        };
    }
    best.cloned()
}

/// True when the notice sits at or before its key's dismissal horizon (the
/// TS `isIncidentNoticeDismissed`).
pub fn is_incident_notice_dismissed(
    notice: &IncidentNotice,
    horizons: &HashMap<String, i64>,
) -> bool {
    horizons
        .get(&notice.key)
        .is_some_and(|horizon| notice.time_ms <= *horizon)
}

/// Dismiss the notice currently showing: records its `time_ms` as the
/// horizon for its key, so the same incident (and older ones on that key)
/// never re-render, while a newer qualifying incident does. False when no
/// notice is showing.
pub fn dismiss_incident_notice_state(state: &mut IncidentNoticeState) -> bool {
    let Some(notice) = state.notice.take() else {
        return false;
    };
    let horizon = state.dismissed_horizons.entry(notice.key).or_insert(0);
    *horizon = (*horizon).max(notice.time_ms);
    true
}

fn same_incident_notice(a: &Option<IncidentNotice>, b: &Option<IncidentNotice>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a.key == b.key && a.time_ms == b.time_ms && a.text == b.text,
        _ => false,
    }
}

/// One bounded read of the log: the complete lines it produced and where
/// the next read continues.
#[derive(Debug)]
pub struct IncidentLogChunk {
    pub lines: Vec<String>,
    pub next_offset: u64,
    pub file_id: Option<SocketIdentity>,
}

/// Rotation-safe incremental read of the daemon log (the TS
/// `readIncidentLogLines`). Without a previous offset — or after a
/// rotation (a changed file identity), a shrink (recreation in place), or
/// more than one tail bound of new bytes — read the bounded tail: the cut
/// may begin mid-line (drop the torn leading fragment) or exactly at a
/// record boundary (keep the intact first record). Otherwise read only
/// appended bytes. A trailing partial line is held back, so a mid-write
/// line parses only once complete on a later poll — unless
/// `include_final_partial_line` is set for a frozen file (the rotated
/// `.log.1`), which no later poll can complete. A missing or unreadable
/// file returns `None`; consumed offsets are never re-processed.
pub fn read_incident_log_lines(
    log_path: &Path,
    previous_offset: Option<u64>,
    previous_file_id: Option<SocketIdentity>,
    include_final_partial_line: bool,
) -> Option<IncidentLogChunk> {
    let mut file = std::fs::File::open(log_path).ok()?;
    let metadata = file.metadata().ok()?;
    let file_id = pa_types::platform::identity::socket_identity(log_path);
    let size = metadata.len();
    let rotated = previous_file_id.is_some_and(|previous| file_id != Some(previous));
    // Re-tail when nothing was read yet, after a rotation (a new file), when
    // the file shrank (recreated in place), or when more than one tail bound
    // appended since the last poll; every read stays bounded and offsets are
    // never re-processed. On platforms without a file identity, rotation is
    // caught by the shrink/re-tail checks instead.
    let retailed = previous_offset.is_none()
        || rotated
        || previous_offset.is_some_and(|offset| offset > size)
        || previous_offset
            .is_some_and(|offset| size.saturating_sub(offset) > INCIDENT_NOTICE_TAIL_BYTES);
    let start = if retailed {
        size.saturating_sub(INCIDENT_NOTICE_TAIL_BYTES)
    } else {
        previous_offset.unwrap_or(0)
    };
    if start >= size {
        return Some(IncidentLogChunk {
            lines: Vec::new(),
            next_offset: size,
            file_id,
        });
    }
    let mut buffer = vec![0u8; (size - start) as usize];
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut total_read = 0;
    while total_read < buffer.len() {
        let read = file.read(&mut buffer[total_read..]).ok()?;
        if read == 0 {
            break;
        }
        total_read += read;
    }
    let mut line_start = 0usize;
    if retailed && start > 0 {
        // The bounded tail may begin mid-line (the cut split a record: drop
        // the torn leading fragment) or exactly at a record boundary (the byte
        // before the cut is a newline: the first line in the buffer is a
        // complete record, and dropping it would silently lose a qualifying
        // incident for the lifetime of the state).
        let mut preceding = [0u8; 1];
        let begins_mid_line = file
            .seek(SeekFrom::Start(start - 1))
            .and_then(|_| file.read(&mut preceding))
            .map(|read| read != 1 || preceding[0] != NEWLINE_BYTE)
            .unwrap_or(true);
        if begins_mid_line {
            // A chunk with no newline at all is one mid-write line: hold it
            // back so the completed line is still parsed by the next poll.
            let Some(first_newline) = buffer[..total_read]
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
    let mut end = total_read;
    // A frozen file (the rotated generation) never gets the completing
    // write, so its final line is returned as-is; a torn line parses to
    // None and drops harmlessly.
    if !include_final_partial_line && end > 0 && buffer[end - 1] != NEWLINE_BYTE {
        // Hold back the partially-written final line until it completes.
        let last_newline = buffer[..total_read]
            .iter()
            .rposition(|byte| *byte == NEWLINE_BYTE);
        let Some(last_newline) = last_newline else {
            return Some(IncidentLogChunk {
                lines: Vec::new(),
                next_offset: start,
                file_id,
            });
        };
        if last_newline < line_start {
            return Some(IncidentLogChunk {
                lines: Vec::new(),
                next_offset: start,
                file_id,
            });
        }
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

/// Keep windowed entries in stable time order across polls: new entries
/// append, everything older than the window drops, and only the newest
/// [`INCIDENT_NOTICE_MAX_WINDOW_ENTRIES`] survive, so memory and per-poll
/// work stay bounded (the TS `mergeIncidentWindowedEntries`).
fn merge_incident_windowed_entries(
    entries: Vec<IncidentLogEntry>,
    parsed: Vec<IncidentLogEntry>,
    since_ms: i64,
) -> Vec<IncidentLogEntry> {
    let mut merged = entries;
    merged.extend(parsed);
    merged.sort_by(|a, b| a.time_ms.cmp(&b.time_ms));
    merged.retain(|entry| entry.time_ms >= since_ms);
    if merged.len() > INCIDENT_NOTICE_MAX_WINDOW_ENTRIES {
        let excess = merged.len() - INCIDENT_NOTICE_MAX_WINDOW_ENTRIES;
        merged.drain(..excess);
    }
    merged
}

/// One best-effort poll (the TS `refreshIncidentNoticeState`): read new log
/// bytes, keep the 24h window, re-derive the qualifying notices, apply the
/// dismissal horizons, and keep the single collapsed line worth showing.
/// The first successful read also tails the rotated `.log.1` generation —
/// matching the CLI's source list — so incidents spanning a rotation still
/// surface in a fresh view; a rotation between polls is bridged by
/// continuing the old generation from its consumed offset (never
/// re-read from its start, which would duplicate update exits into
/// phantom replacements). A missing or unreadable log keeps the consumed
/// offset and file id exactly as they are (a re-tail would fabricate
/// restarts) but still re-derives, so the notice expires with its window.
/// Returns whether the collapsed line changed, so the caller re-renders.
pub fn refresh_incident_notice_state(
    state: &mut IncidentNoticeState,
    log_path: &Path,
    now_ms: i64,
) -> bool {
    let first_read = state.log_offset.is_none() && state.log_file_id.is_none();
    let chunk = read_incident_log_lines(log_path, state.log_offset, state.log_file_id, false);
    let since_ms = now_ms - INCIDENT_NOTICE_WINDOW_MS;
    let daemon = log_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let parse_windowed_lines = |lines: &[String]| -> Vec<IncidentLogEntry> {
        lines
            .iter()
            .filter_map(|line| crate::incident::parse_daemon_log_line(line, &daemon))
            .filter(|entry| entry.time_ms >= since_ms && entry.time_ms <= now_ms)
            .collect()
    };
    let mut parsed: Vec<IncidentLogEntry> = Vec::new();
    if let Some(chunk) = &chunk {
        // The rotated generation: tailed on the first read (frozen: its final
        // line is returned as-is), and continued from the consumed offset
        // when the live read just detected the rotation — a rename can land
        // between the two reads, so bridge only a genuinely different file.
        let rotated_path = log_path.with_extension("log.1");
        if first_read {
            if let Some(rotated) = read_incident_log_lines(&rotated_path, None, None, true) {
                if rotated
                    .file_id
                    .is_none_or(|rotated_id| Some(rotated_id) != chunk.file_id)
                {
                    parsed.extend(parse_windowed_lines(&rotated.lines));
                }
            }
        } else if state
            .log_file_id
            .is_some_and(|previous| Some(previous) != chunk.file_id)
        {
            if let Some(rotated_tail) =
                read_incident_log_lines(&rotated_path, state.log_offset, state.log_file_id, true)
            {
                parsed.extend(parse_windowed_lines(&rotated_tail.lines));
            }
        }
        parsed.extend(parse_windowed_lines(&chunk.lines));
        state.log_offset = Some(chunk.next_offset);
        state.log_file_id = chunk.file_id;
    }
    let previous = state.notice.clone();
    state.entries =
        merge_incident_windowed_entries(std::mem::take(&mut state.entries), parsed, since_ms);
    let notices = derive_incident_notices(&state.entries, now_ms);
    let visible: Vec<IncidentNotice> = notices
        .into_iter()
        .filter(|notice| !is_incident_notice_dismissed(notice, &state.dismissed_horizons))
        .collect();
    state.notice = select_incident_notice(&visible);
    !same_incident_notice(&previous, &state.notice)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::incident::parse_rfc3339_ms;

    fn line(time_ms: i64, msg: &str) -> String {
        let (year, month, day, hour, minute, second) = crate::incident::civil_from_ms(time_ms);
        format!("[{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.000Z] {msg}")
    }

    fn temp_log(name: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let path = dir.path().join(name);
        (dir, path)
    }

    #[test]
    fn notice_time_labels_today_and_older_days() {
        let now = crate::incident::utc_ms(2026, 9, 24, 14, 30, 0, 0);
        assert_eq!(format_incident_notice_time(now - 60_000, now), "14:29");
        let yesterday = crate::incident::utc_ms(2026, 9, 23, 23, 10, 0, 0);
        assert_eq!(format_incident_notice_time(yesterday, now), "9/23 23:10");
        let last_year = crate::incident::utc_ms(2025, 9, 23, 23, 10, 0, 0);
        assert_eq!(format_incident_notice_time(last_year, now), "25/9/23 23:10");
    }

    #[test]
    fn derives_worker_crash_notice() {
        let now = crate::incident::utc_ms(2026, 9, 24, 14, 30, 0, 0);
        let crash_time = now - 60_000;
        let entries = vec![crate::incident::IncidentLogEntry {
            time_ms: crash_time,
            daemon: "prime-agent.sock.a1b2c3d4".to_string(),
            msg:
                "session worker 5b1d3aeb91ee exited unexpectedly; restarting in 250ms (failure 1/5)"
                    .to_string(),
        }];
        let notices = derive_incident_notices(&entries, now);
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].kind, IncidentNoticeKind::WorkerCrash);
        assert_eq!(notices[0].key, "worker-crash|worker 5b1d3aeb91ee");
        assert_eq!(notices[0].severity, IncidentSeverity::Critical);
        assert_eq!(notices[0].text, "worker 5b1d3aeb91ee crashed at 14:29");
        // Outside the window: not surfaced.
        assert!(derive_incident_notices(&entries, now + INCIDENT_NOTICE_WINDOW_MS + 1).is_empty());
    }

    #[test]
    fn derives_timeout_burst_notice_with_cluster_tail_anchor() {
        let now = crate::incident::utc_ms(2026, 9, 24, 14, 30, 0, 0);
        let timeout = "session worker 5b1d3aeb91ee command attach timed out after 30000ms";
        let entries: Vec<crate::incident::IncidentLogEntry> = (0..4)
            .map(|index| crate::incident::IncidentLogEntry {
                time_ms: now - 400_000 + index * 60_000,
                daemon: "d".to_string(),
                msg: timeout.to_string(),
            })
            .collect();
        let notices = derive_incident_notices(&entries, now);
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].kind, IncidentNoticeKind::TimeoutBurst);
        // The anchor is the cluster's LATEST timeout, not the first.
        assert_eq!(notices[0].time_ms, now - 400_000 + 3 * 60_000);
        assert!(notices[0]
            .text
            .starts_with("worker 5b1d3aeb91ee: 4 command timeouts over 3m"));

        // An isolated stray timeout never opens a burst.
        let isolated = vec![crate::incident::IncidentLogEntry {
            time_ms: now - 1000,
            daemon: "d".to_string(),
            msg: timeout.to_string(),
        }];
        assert!(derive_incident_notices(&isolated, now).is_empty());
    }

    #[test]
    fn derives_update_restart_notice() {
        let now = crate::incident::utc_ms(2026, 9, 24, 14, 30, 0, 0);
        let exit_time = now - 120_000;
        let entries = vec![crate::incident::IncidentLogEntry {
            time_ms: exit_time,
            daemon: "prime-agent.sock.a1b2c3d4".to_string(),
            msg: "update 7f3c: all 3 worker(s) stopped; exiting for the update".to_string(),
        }];
        let notices = derive_incident_notices(&entries, now);
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].kind, IncidentNoticeKind::UpdateRestart);
        assert!(notices[0]
            .text
            .starts_with("daemon restarting for update 7f3c"));
        assert!(notices[0].text.ends_with("at 14:28"));
    }

    #[test]
    fn selects_most_severe_then_most_recent() {
        let now = crate::incident::utc_ms(2026, 9, 24, 14, 30, 0, 0);
        let crash = IncidentNotice {
            kind: IncidentNoticeKind::WorkerCrash,
            key: "worker-crash|worker a".to_string(),
            severity: IncidentSeverity::Critical,
            subject: "worker a".to_string(),
            time_ms: now - 5000,
            text: "crash".to_string(),
        };
        let restart = IncidentNotice {
            kind: IncidentNoticeKind::UpdateRestart,
            key: "update-restart|daemon d".to_string(),
            severity: IncidentSeverity::Info,
            subject: "daemon d".to_string(),
            time_ms: now - 1000,
            text: "restart".to_string(),
        };
        let selected = select_incident_notice(&[restart.clone(), crash.clone()]).expect("notice");
        assert_eq!(selected, crash);
        let newer_crash = IncidentNotice {
            time_ms: now - 1,
            ..crash.clone()
        };
        let selected = select_incident_notice(&[crash, newer_crash.clone()]).expect("notice");
        assert_eq!(selected, newer_crash);
    }

    #[test]
    fn dismissal_horizons_hide_old_and_admit_new_incidents() {
        let now = crate::incident::utc_ms(2026, 9, 24, 14, 30, 0, 0);
        let mut state = IncidentNoticeState::new();
        let crash_at = |time_ms: i64| IncidentNotice {
            kind: IncidentNoticeKind::WorkerCrash,
            key: "worker-crash|worker a".to_string(),
            severity: IncidentSeverity::Critical,
            subject: "worker a".to_string(),
            time_ms,
            text: "worker a crashed".to_string(),
        };
        assert!(
            !dismiss_incident_notice_state(&mut state),
            "nothing showing yet"
        );
        state.notice = Some(crash_at(now - 1000));
        assert!(dismiss_incident_notice_state(&mut state));
        assert!(state.notice.is_none());
        assert!(is_incident_notice_dismissed(
            &crash_at(now - 1000),
            &state.dismissed_horizons
        ));
        assert!(is_incident_notice_dismissed(
            &crash_at(now - 2000),
            &state.dismissed_horizons
        ));
        // A newer incident on the same key resurfaces.
        assert!(!is_incident_notice_dismissed(
            &crash_at(now - 1),
            &state.dismissed_horizons
        ));
    }

    #[test]
    fn reads_incrementally_and_holds_back_partial_lines() {
        let (_dir, path) = temp_log("prime-agent.sock.a1b2c3d4.log");
        let now = crate::incident::utc_ms(2026, 9, 24, 14, 30, 0, 0);
        let full = format!(
            "{}\n{}\n",
            line(now - 1000, "first event"),
            line(now - 900, "second event")
        );
        std::fs::write(&path, full).expect("log");

        let mut state = IncidentNoticeState::new();
        let changed = refresh_incident_notice_state(&mut state, &path, now);
        assert!(!changed, "no qualifying incident on a quiet log");
        assert_eq!(state.entries.len(), 2);
        let consumed = state.log_offset.expect("offset");

        // Append one complete line and one partial line: only the complete
        // line parses this poll; the partial waits for its newline.
        let appended = format!(
            "{}\n{}",
            line(now - 800, "third event"),
            line(now - 700, "fourth even")
        );
        std::fs::write(&path, format!("{full}{appended}")).expect("appended log");
        let changed = refresh_incident_notice_state(&mut state, &path, now);
        assert!(!changed, "no qualifying incident changed the line");
        assert_eq!(state.entries.len(), 3, "the partial line waits");
        let offset_after = state.log_offset.expect("offset");

        // Completing the line parses it exactly once.
        std::fs::write(&path, format!("{full}{appended}t event\n")).expect("completed log");
        refresh_incident_notice_state(&mut state, &path, now);
        assert_eq!(state.entries.len(), 4);
        assert!(state.log_offset.expect("offset") > offset_after);
        assert!(offset_after > consumed, "offsets only advance");
    }

    #[test]
    fn rotation_to_log_1_continues_the_consumed_offset() {
        let (_dir, path) = temp_log("prime-agent.sock.a1b2c3d4.log");
        let now = crate::incident::utc_ms(2026, 9, 24, 14, 30, 0, 0);
        let first = format!("{}\n", line(now - 3000, "before the rotation"));
        std::fs::write(&path, &first).expect("log");

        let mut state = IncidentNoticeState::new();
        refresh_incident_notice_state(&mut state, &path, now);
        assert_eq!(state.entries.len(), 1);

        // Rotate: the consumed generation moves to `.log.1`, a fresh file
        // takes the live path, and the un-consumed tail of the old
        // generation must still surface (the crash logged in the gap).
        let crash = line(
            now - 1000,
            "session worker 5b1d3aeb91ee exited unexpectedly; restarting in 250ms (failure 1/5)",
        );
        let rotated = path.with_extension("log.1");
        std::fs::write(&rotated, format!("{first}{crash}\n")).expect("rotated log");
        std::fs::write(
            &path,
            format!("{}\n", line(now - 500, "after the rotation")),
        )
        .expect("fresh log");

        let changed = refresh_incident_notice_state(&mut state, &path, now);
        assert!(changed, "the crash surfaced");
        let notice = state.notice.expect("notice");
        assert_eq!(notice.kind, IncidentNoticeKind::WorkerCrash);
        // No duplication: the pre-rotation line is parsed once.
        assert_eq!(
            state
                .entries
                .iter()
                .filter(|entry| entry.msg.contains("before the rotation"))
                .count(),
            1
        );
    }

    #[test]
    fn first_read_bridges_the_rotated_generation() {
        let (_dir, path) = temp_log("prime-agent.sock.a1b2c3d4.log");
        let now = crate::incident::utc_ms(2026, 9, 24, 14, 30, 0, 0);
        // A fresh view opening after a rotation: the crash sits in `.log.1`.
        let crash = line(
            now - 2000,
            "session worker 5b1d3aeb91ee exited unexpectedly; restarting in 250ms (failure 1/5)",
        );
        std::fs::write(path.with_extension("log.1"), format!("{crash}\n")).expect("rotated log");
        std::fs::write(&path, format!("{}\n", line(now - 1000, "live generation")))
            .expect("live log");

        let mut state = IncidentNoticeState::new();
        let changed = refresh_incident_notice_state(&mut state, &path, now);
        assert!(changed);
        assert_eq!(state.entries.len(), 2, "both generations parsed once");
        assert_eq!(
            state.notice.expect("notice").kind,
            IncidentNoticeKind::WorkerCrash
        );
    }

    #[test]
    fn retails_when_more_than_one_tail_bound_appends() {
        let (_dir, path) = temp_log("prime-agent.sock.a1b2c3d4.log");
        let now = crate::incident::utc_ms(2026, 9, 24, 14, 30, 0, 0);
        let old = format!("{}\n", line(now - 4000, "old tail"));
        std::fs::write(&path, &old).expect("log");
        let mut state = IncidentNoticeState::new();
        refresh_incident_notice_state(&mut state, &path, now);
        assert_eq!(state.entries.len(), 1);

        // More than the tail bound appends: the next read re-tails (stays
        // bounded) and keeps qualifying events from the newest bytes.
        let filler = "x".repeat((INCIDENT_NOTICE_TAIL_BYTES + 1024) as usize);
        let crash = line(
            now - 1,
            "session worker 5b1d3aeb91ee exited unexpectedly; restarting in 250ms (failure 1/5)",
        );
        std::fs::write(&path, format!("{old}{filler}\n{crash}\n")).expect("grown log");
        let changed = refresh_incident_notice_state(&mut state, &path, now);
        assert!(changed);
        assert_eq!(
            state.notice.expect("notice").kind,
            IncidentNoticeKind::WorkerCrash
        );
    }

    #[test]
    fn missing_log_keeps_the_consumed_offset_and_expires_the_notice() {
        let (_dir, path) = temp_log("prime-agent.sock.a1b2c3d4.log");
        let now = crate::incident::utc_ms(2026, 9, 24, 14, 30, 0, 0);
        let crash = line(
            now - 1000,
            "session worker 5b1d3aeb91ee exited unexpectedly; restarting in 250ms (failure 1/5)",
        );
        std::fs::write(&path, format!("{crash}\n")).expect("log");
        let mut state = IncidentNoticeState::new();
        refresh_incident_notice_state(&mut state, &path, now);
        assert!(state.notice.is_some());
        let offset = state.log_offset;
        let file_id = state.log_file_id;

        // The log disappears (unreadable): the consumed offset never
        // resets, and the notice ages out of its window instead of
        // surviving forever.
        std::fs::remove_file(&path).expect("removed");
        refresh_incident_notice_state(&mut state, &path, now);
        assert_eq!(state.log_offset, offset);
        assert_eq!(state.log_file_id, file_id);
        assert_eq!(state.entries.len(), 1, "windowed entries kept");
        // Ages out once the incident leaves the 24h window.
        refresh_incident_notice_state(&mut state, &path, now + INCIDENT_NOTICE_WINDOW_MS + 10_000);
        assert!(state.notice.is_none());
    }

    #[test]
    fn dismissal_survives_view_reentry() {
        let (_dir, path) = temp_log("prime-agent.sock.a1b2c3d4.log");
        let now = crate::incident::utc_ms(2026, 9, 24, 14, 30, 0, 0);
        let crash = format!(
            "{}\n",
            line(now - 1000, "session worker 5b1d3aeb91ee exited unexpectedly; restarting in 250ms (failure 1/5)")
        );
        std::fs::write(&path, &crash).expect("log");
        let mut state = IncidentNoticeState::new();
        refresh_incident_notice_state(&mut state, &path, now);
        assert!(state.notice.is_some());
        assert!(dismiss_incident_notice_state(&mut state));

        // A re-entry carries the same state: the same incident stays
        // dismissed, and the poll continues from the consumed offset.
        let changed = refresh_incident_notice_state(&mut state, &path, now);
        assert!(!changed);
        assert!(state.notice.is_none());
        assert_eq!(state.entries.len(), 1);
    }

    #[test]
    fn parse_daemon_log_line_via_public_api_still_pins_the_shape() {
        let parsed = parse_rfc3339_ms("2026-09-24T14:29:59.000Z").expect("timestamp");
        assert_eq!(
            crate::incident::civil_from_ms(parsed),
            (2026, 9, 24, 14, 29, 59)
        );
    }
}
