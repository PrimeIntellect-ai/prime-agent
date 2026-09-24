//! Daemon-log incident forensics, ported from TS `cli/incident.ts` (TS PR
//! #2406) and adapted to the rust daemon's actual log shape: per-socket
//! plain-text logs (`<agent-dir>/logs/<socket>.<hash8>.log`, written by
//! `pa_daemon::supervisor::Supervisor::log_line` as one `[<RFC3339 UTC>]
//! <message>` line per event, with one `.log.1` rotation). The TS source
//! reads a shared structured `agent.jsonl` (level/component/pid fields);
//! rust logs carry none of that, so the classifier keys events off the
//! message strings the supervisor actually emits and keys daemon-level
//! events by the log file's socket name. The command-timeout,
//! worker-auth-failure, and provider-stream-failure lines have no
//! producer yet (their supervisor/worker call sites land with the
//! `incident-enrichment` follow-up); the classifier arms below pin
//! their shapes so that lane only has to start writing them.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Default report window, mirroring the TS CLI: the last 24 hours.
pub const DEFAULT_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;
/// A session-level event gap at least this long reads as a stall.
const STALL_GAP_MS: i64 = 10 * 60 * 1000;
/// A burst is several warnings/errors close together; isolated failures
/// far apart are not one incident.
const ERROR_BURST_THRESHOLD: usize = 3;
const ERROR_BURST_WINDOW_MS: i64 = 10 * 60 * 1000;
/// Only timeouts within this window of each other form a stall, whatever
/// the report window is; the notices module derives its dismissal horizon
/// from the same bound via [`latest_stall_timeout_by_subject`].
const TIMEOUT_STALL_WINDOW_MS: i64 = 30 * 60 * 1000;
const SUMMARY_TRUNCATION: usize = 120;
/// Per-daemon logs are named `<socket basename>.<hash8>.log` (the
/// supervisor's rotating appender), with one `<...>.log.1` generation.
const DAEMON_LOG_FILE_PATTERN: &str = r"\.[0-9a-f]{8}\.log(\.1)?$";

/// The timeline's severity levels, ranked low to high.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum IncidentSeverity {
    Info,
    Warn,
    Error,
    Critical,
}

impl IncidentSeverity {
    pub fn as_str(self) -> &'static str {
        match self {
            IncidentSeverity::Info => "info",
            IncidentSeverity::Warn => "warn",
            IncidentSeverity::Error => "error",
            IncidentSeverity::Critical => "critical",
        }
    }

    /// The TS `chalk` colors: red for error/critical, yellow for warn,
    /// dim for info.
    fn colorize(self, label: &str) -> String {
        match self {
            IncidentSeverity::Critical | IncidentSeverity::Error => {
                format!("\x1b[31m{label}\x1b[39m")
            }
            IncidentSeverity::Warn => format!("\x1b[33m{label}\x1b[39m"),
            IncidentSeverity::Info => format!("\x1b[2m{label}\x1b[22m"),
        }
    }
}

/// One section of the operator timeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IncidentCategory {
    Supervisor,
    Anomaly,
    Recovery,
}

impl IncidentCategory {
    fn title(self) -> &'static str {
        match self {
            IncidentCategory::Supervisor => "Supervisor events",
            IncidentCategory::Anomaly => "Session anomalies",
            IncidentCategory::Recovery => "Recovery",
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            IncidentCategory::Supervisor => "supervisor",
            IncidentCategory::Anomaly => "anomaly",
            IncidentCategory::Recovery => "recovery",
        }
    }
}

/// The classifier's event vocabulary: drives anomaly computation (timeouts
/// stall, burst classes burst) and the agents-view notice triggers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IncidentEventClass {
    WorkerStart,
    WorkerStop,
    WorkerCrash,
    Timeout,
    Auth,
    CommandFailure,
    Diagnostic,
    /// The supervisor exited for an update (a supervisor replacement).
    SupervisorRestart,
    SupervisorAction,
    RecoveryAction,
    RecoveryFailure,
    Provider,
    /// The computed per-subject stall/burst/gap anomalies.
    Anomaly,
}

/// One parsed daemon-log line: the timestamp plus the message, keyed by
/// the daemon that wrote it (the log file's socket name).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncidentLogEntry {
    pub time_ms: i64,
    /// The writing daemon's log base name (`<socket>.<hash8>`), so events
    /// from different daemons sharing one logs dir never mix subjects.
    pub daemon: String,
    pub msg: String,
}

/// One classified incident event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncidentEvent {
    pub time_ms: i64,
    pub severity: IncidentSeverity,
    pub category: IncidentCategory,
    pub event_class: IncidentEventClass,
    pub subject: String,
    pub summary: String,
    /// Session/worker ids named by the event, for the `--session` filter.
    pub tokens: Vec<String>,
}

/// The daemon logs one `incident` run scanned.
#[derive(Debug, Default)]
pub struct IncidentLogSource {
    pub entries: Vec<IncidentLogEntry>,
    pub scanned_count: usize,
    pub skipped_count: usize,
    /// The log files read, comma-joined (the TS source line).
    pub source: String,
}

/// The `--since`/`--until`/`--session` options of `prime-agent incident`.
#[derive(Debug, Default)]
pub struct IncidentCommandOptions {
    pub since: Option<String>,
    pub until: Option<String>,
    pub session: Option<String>,
}

/// A resolved `--since <time>`/`--until <time>` window.
#[derive(Debug, Clone, Copy)]
pub struct IncidentWindow {
    pub since_ms: i64,
    pub until_ms: i64,
}

/// The report options: the resolved window, the optional session filter,
/// and the source metadata (the TS `IncidentReportOptions`).
#[derive(Debug)]
pub struct IncidentReportOptions<'a> {
    pub window: IncidentWindow,
    pub session: Option<&'a str>,
    pub source: Option<&'a IncidentLogSource>,
}

// ---------------------------------------------------------------------------
// Time helpers (UTC; no external time crate — the same civil-from-days
// algorithm the daemon's `util.rs` uses)
// ---------------------------------------------------------------------------

const MONTH_DAYS: [i64; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: i64) -> i64 {
    if month == 2 && is_leap_year(year) {
        29
    } else {
        MONTH_DAYS[(month.clamp(1, 12) - 1) as usize]
    }
}

/// Days from the Unix epoch to the civil date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Milliseconds from the epoch for a UTC civil date-time.
pub(crate) fn utc_ms(
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    minute: i64,
    second: i64,
    millis: i64,
) -> i64 {
    days_from_civil(year, month, day) * 86_400_000
        + hour * 3_600_000
        + minute * 60_000
        + second * 1000
        + millis
}

/// Civil date-time from epoch milliseconds (UTC).
pub(crate) fn civil_from_ms(ms: i64) -> (i64, i64, i64, i64, i64, i64) {
    let days = ms.div_euclid(86_400_000);
    let mut rem = ms.rem_euclid(86_400_000);
    let hour = rem / 3_600_000;
    rem -= hour * 3_600_000;
    let minute = rem / 60_000;
    rem -= minute * 60_000;
    let second = rem / 1000;
    // Civil from days (Howard Hinnant's algorithm).
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
    (year, month, day, hour, minute, second)
}

/// Epoch milliseconds from an RFC 3339 timestamp: the daemon's
/// `util::now_iso` writes `YYYY-MM-DDTHH:MM:SS.mmmZ`; the CLI bounds also
/// accept a date (`YYYY-MM-DD`, midnight), minute precision
/// (`YYYY-MM-DDTHH:MM`), and an explicit zone offset (a hand-copied
/// timestamp off a different machine's clock). `None` for anything else.
pub fn parse_rfc3339_ms(ts: &str) -> Option<i64> {
    let bytes = ts.as_bytes();
    if bytes.len() < 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year: i64 = ts.get(0..4)?.parse().ok()?;
    let month: i64 = ts.get(5..7)?.parse().ok()?;
    let day: i64 = ts.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=days_in_month(year, month)).contains(&day) {
        return None;
    }
    if bytes.len() == 10 {
        return Some(utc_ms(year, month, day, 0, 0, 0, 0));
    }
    if (bytes[10] != b'T' && bytes[10] != b' ') || bytes.len() < 16 || bytes[13] != b':' {
        return None;
    }
    let hour: i64 = ts.get(11..13)?.parse().ok()?;
    let minute: i64 = ts.get(14..16)?.parse().ok()?;
    if !(0..=23).contains(&hour) || !(0..=59).contains(&minute) {
        return None;
    }
    let (second, millis, mut rest) = (0i64, 0i64, &ts[16..]);
    if bytes.len() > 16 && bytes[16] == b':' {
        if bytes.len() < 19 {
            return None;
        }
        let second: i64 = ts.get(17..19)?.parse().ok()?;
        if !(0..=59).contains(&second) {
            return None;
        }
        rest = &ts[19..];
        if rest.starts_with('.') {
            let digits: String = rest[1..].chars().take_while(char::is_ascii_digit).collect();
            if digits.is_empty() {
                return None;
            }
            let fraction = digits.get(..3).unwrap_or(&digits);
            millis = format!("{fraction:0<3}").parse().ok()?;
            rest = &rest[1 + digits.len()..];
        }
        return finish_rfc3339(year, month, day, hour, minute, second, millis, rest);
    }
    finish_rfc3339(year, month, day, hour, minute, second, millis, rest)
}

/// Apply the zone suffix (`Z`, an explicit `±HH(:MM)` offset, or none for
/// UTC — the timestamps the daemon logs).
fn finish_rfc3339(
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    minute: i64,
    second: i64,
    millis: i64,
    rest: &str,
) -> Option<i64> {
    let offset_ms = match rest {
        "" | "Z" | "z" => 0,
        other if other.starts_with('+') || other.starts_with('-') => {
            let sign = if other.starts_with('-') { -1 } else { 1 };
            let digits = other[1..].replace(':', "");
            if digits.len() < 2 || digits.len() > 4 || !digits.chars().all(char::is_ascii_digit) {
                return None;
            }
            let hours: i64 = digits[..2].parse().ok()?;
            let minutes: i64 = digits
                .get(2..)
                .map(|tail| tail.parse::<i64>().unwrap_or_default())
                .unwrap_or_default();
            if hours >= 24 || minutes >= 60 {
                return None;
            }
            sign * (hours * 60 + minutes) * 60_000
        }
        _ => return None,
    };
    Some(utc_ms(year, month, day, hour, minute, second, millis) - offset_ms)
}

/// Parse a `--since`/`--until` bound (TS `parseIncidentTimeBound`):
/// `HH:MM` reads as today UTC, `YYYY-MM-DD[THH:MM[:SS[.fff]]][Z|±HH(:MM)]`
/// as the full instant. UTC matches the timestamps the daemon logs.
pub fn parse_incident_time_bound(value: &str, now_ms: i64, flag: &str) -> Result<i64, String> {
    let raw = value.trim();
    if raw.is_empty() {
        return Err(format!("{flag} requires a time."));
    }
    let invalid = || {
        format!(
            "Invalid time for {flag}: \"{value}\". Use \"2026-09-16T20:02\", \"2026-09-16\", or \"20:02\" (today, UTC)."
        )
    };
    let (year, month, day, _, _) = civil_from_ms(now_ms);
    if raw.len() == 5 && raw.as_bytes()[2] == b':' {
        let hour: i64 = raw[..2].parse().map_err(|_| invalid())?;
        let minute: i64 = raw[3..5].parse().map_err(|_| invalid())?;
        if !(0..=23).contains(&hour) || !(0..=59).contains(&minute) {
            return Err(invalid());
        }
        return Ok(utc_ms(year, month, day, hour, minute, 0, 0));
    }
    parse_rfc3339_ms(raw).ok_or_else(invalid)
}

/// Resolve the `--since`/`--until` window: the default is the last 24
/// hours until now; an explicit window must be ordered (TS
/// `resolveIncidentWindow`).
pub fn resolve_incident_window(
    options: &IncidentCommandOptions,
    now_ms: i64,
) -> Result<IncidentWindow, String> {
    let since_ms = match &options.since {
        Some(since) => parse_incident_time_bound(since, now_ms, "--since")?,
        None => now_ms - DEFAULT_WINDOW_MS,
    };
    let until_ms = match &options.until {
        Some(until) => parse_incident_time_bound(until, now_ms, "--until")?,
        None => now_ms,
    };
    if until_ms <= since_ms {
        return Err("--until must be after --since.".to_string());
    }
    Ok(IncidentWindow { since_ms, until_ms })
}

/// `MM-DD HH:MM:SS` UTC (the TS `formatIncidentTime`).
fn format_incident_time(ms: i64) -> String {
    let (_, month, day, hour, minute, second) = civil_from_ms(ms);
    format!("{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}")
}

/// `1h30m`, `10m7s`, `19s`-style durations (the TS
/// `formatIncidentDuration`).
fn format_incident_duration(ms: i64) -> String {
    let total_seconds = (ms / 1000).max(1);
    let seconds = total_seconds % 60;
    let minutes = (total_seconds / 60) % 60;
    let hours = total_seconds / 3600;
    if hours > 0 {
        if minutes > 0 {
            format!("{hours}h{minutes}m")
        } else {
            format!("{hours}h")
        }
    } else if minutes > 0 {
        if seconds > 0 {
            format!("{minutes}m{seconds}s")
        } else {
            format!("{minutes}m")
        }
    } else {
        format!("{seconds}s")
    }
}

// ---------------------------------------------------------------------------
// Log parsing
// ---------------------------------------------------------------------------

/// Parse one daemon-log line: `[<RFC3339 UTC>] <message>`. Malformed lines
/// return `None` and the reader counts them skipped.
pub fn parse_daemon_log_line(line: &str, daemon: &str) -> Option<IncidentLogEntry> {
    let trimmed = line.trim();
    let rest = trimmed.strip_prefix('[')?;
    let (ts, rest) = rest.split_once(']')?;
    let msg = rest.trim();
    if msg.is_empty() {
        return None;
    }
    let time_ms = parse_rfc3339_ms(ts.trim())?;
    Some(IncidentLogEntry {
        time_ms,
        daemon: daemon.to_string(),
        msg: msg.to_string(),
    })
}

fn daemon_log_file_pattern() -> &'static regex::Regex {
    static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    PATTERN
        .get_or_init(|| regex::Regex::new(DAEMON_LOG_FILE_PATTERN).expect("log file name pattern"))
}

/// The daemon log files under one logs dir, rotated generation first for
/// each daemon: `<socket>.<hash8>.log.1` (the rotated generation) then
/// `<socket>.<hash8>.log`. A missing dir returns empty.
pub fn daemon_log_files(logs_dir: &Path) -> Vec<PathBuf> {
    let Ok(names) = std::fs::read_dir(logs_dir) else {
        return Vec::new();
    };
    let mut paths: Vec<(bool, String, PathBuf)> = Vec::new();
    for entry in names.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !daemon_log_file_pattern().is_match(&name) {
            continue;
        }
        let rotated = name.ends_with(".log.1");
        paths.push((rotated, name, entry.path()));
    }
    paths.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(&b.0)));
    paths.into_iter().map(|(_, _, path)| path).collect()
}

/// The log base name (`<socket>.<hash8>`) identifying the writing daemon.
fn daemon_name(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "daemon".to_string());
    if let Some(stripped) = name
        .strip_suffix(".log.1")
        .or_else(|| name.strip_suffix(".log"))
    {
        stripped.to_string()
    } else {
        name
    }
}

/// Read every daemon log under the logs dir, merging the entries by time
/// (the per-socket logs are separate files; one timeline interleaves them).
pub fn read_incident_log_entries(logs_dir: &Path) -> IncidentLogSource {
    let mut source = IncidentLogSource::default();
    let mut names: Vec<String> = Vec::new();
    for path in daemon_log_files(logs_dir) {
        let daemon = daemon_name(&path);
        names.push(
            path.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
        );
        let Ok(contents) = std::fs::read_to_string(&path) else {
            continue;
        };
        for line in contents.split('\n') {
            if line.trim().is_empty() {
                continue;
            }
            source.scanned_count += 1;
            match parse_daemon_log_line(line, &daemon) {
                Some(entry) => source.entries.push(entry),
                None => source.skipped_count += 1,
            }
        }
    }
    source.entries.sort_by(|a, b| a.time_ms.cmp(&b.time_ms));
    source.source = names.join(", ");
    source
}

/// The newest daemon log under the logs dir (mtime): the notices poll's
/// source (the TS `newestDaemonLogPath` fallback logic; rust has no shared
/// structured log, so the newest per-daemon log is the live one).
pub fn newest_daemon_log_path(logs_dir: &Path) -> Option<PathBuf> {
    let names = std::fs::read_dir(logs_dir).ok()?;
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in names.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !daemon_log_file_pattern().is_match(&name) || name.ends_with(".log.1") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_dir() {
            continue;
        }
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if newest
            .as_ref()
            .is_none_or(|candidate| modified > candidate.0)
        {
            newest = Some((modified, entry.path()));
        }
    }
    newest.map(|(_, path)| path)
}

// ---------------------------------------------------------------------------
// Classification (the strings `pa-daemon`'s supervisor actually logs)
// ---------------------------------------------------------------------------

fn first_line(text: &str) -> &str {
    text.split('\n').next().unwrap_or_default().trim()
}

/// Truncate on a char boundary (a raw error message may be multi-byte).
fn truncate_text(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let cut: String = trimmed.chars().take(max).collect();
    format!("{cut}...")
}

/// Session/worker ids named by a line: hex runs (12-char display ids, the
/// hash tail of a file name) and dashed UUIDs, so `--session <prefix>`
/// matches both spellings.
fn collect_tokens(text: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        if ch.is_ascii_hexdigit() || ch == '-' {
            current.push(ch);
        } else {
            if current.len() >= 6 {
                tokens.push(current.clone());
            }
            current.clear();
        }
    }
    if current.len() >= 6 {
        tokens.push(current);
    }
    // A run of bare dashes is not an id.
    tokens.retain(|token| !token.chars().all(|ch| ch == '-'));
    tokens
}

fn event(
    entry: &IncidentLogEntry,
    severity: IncidentSeverity,
    category: IncidentCategory,
    event_class: IncidentEventClass,
    subject: String,
    summary: String,
    tokens: Vec<String>,
) -> IncidentEvent {
    IncidentEvent {
        time_ms: entry.time_ms,
        severity,
        category,
        event_class,
        subject,
        summary,
        tokens,
    }
}

fn worker_event(
    entry: &IncidentLogEntry,
    severity: IncidentSeverity,
    category: IncidentCategory,
    event_class: IncidentEventClass,
    worker_id: &str,
    summary: String,
) -> IncidentEvent {
    event(
        entry,
        severity,
        category,
        event_class,
        format!("worker {worker_id}"),
        summary,
        collect_tokens(worker_id),
    )
}

/// Classify one daemon-log line. `None` when the line is noise (routine
/// bookkeeping, unreadable shapes): the timeline must summarize incidents,
/// not echo the log.
pub fn classify_incident_entry(entry: &IncidentLogEntry) -> Option<IncidentEvent> {
    let msg = first_line(&entry.msg);
    let daemon_subject = format!("daemon {}", entry.daemon);

    // Worker lifecycle and per-worker failures, as the supervisor logs
    // them: `session worker <id> <tail>`.
    if let Some(rest) = msg.strip_prefix("session worker ") {
        if let Some((id, tail)) = rest.split_once(' ') {
            if let Some(epoch_tail) = tail
                .strip_prefix("registered (epoch ")
                .or_else(|| tail.strip_prefix("re-registered (epoch "))
            {
                let epoch = epoch_tail.split(')').next().unwrap_or_default();
                let verb = if tail.starts_with("re-") {
                    "re-registered"
                } else {
                    "registered"
                };
                return Some(worker_event(
                    entry,
                    IncidentSeverity::Info,
                    IncidentCategory::Supervisor,
                    IncidentEventClass::WorkerStart,
                    id,
                    format!("session worker {id} {verb} (epoch {epoch})"),
                ));
            }
            if tail.starts_with("stopped intentionally (status ") {
                return Some(worker_event(
                    entry,
                    IncidentSeverity::Info,
                    IncidentCategory::Supervisor,
                    IncidentEventClass::WorkerStop,
                    id,
                    format!("session worker {id} stopped intentionally"),
                ));
            }
            if let Some(restart) = tail.strip_prefix("exited unexpectedly; restarting in ") {
                return Some(worker_event(
                    entry,
                    IncidentSeverity::Critical,
                    IncidentCategory::Supervisor,
                    IncidentEventClass::WorkerCrash,
                    id,
                    format!("session worker {id} crashed; restarting in {restart}"),
                ));
            }
            // `session worker <id> command <cmd> timed out after <ms>ms`
            // (the incident-enrichment lane's supervisor call site).
            if let Some((command, timeout)) = tail
                .strip_prefix("command ")
                .and_then(|rest| rest.strip_suffix("ms"))
                .and_then(|rest| rest.split_once(" timed out after "))
            {
                return Some(worker_event(
                    entry,
                    IncidentSeverity::Error,
                    IncidentCategory::Supervisor,
                    IncidentEventClass::Timeout,
                    id,
                    format!("command {command} timed out on session worker {id} after {timeout}ms"),
                ));
            }
            // `session worker <id> authentication failed: <error>` (the
            // incident-enrichment lane's supervisor call sites).
            if let Some(reason) = tail.strip_prefix("authentication failed: ") {
                return Some(worker_event(
                    entry,
                    IncidentSeverity::Error,
                    IncidentCategory::Supervisor,
                    IncidentEventClass::Auth,
                    id,
                    format!(
                        "session worker {id} authentication failed: {}",
                        truncate_text(reason, 100)
                    ),
                ));
            }
            if let Some(failures) = tail.strip_prefix("failed after ") {
                return Some(worker_event(
                    entry,
                    IncidentSeverity::Error,
                    IncidentCategory::Recovery,
                    IncidentEventClass::RecoveryFailure,
                    id,
                    format!("session worker {id} failed after {failures}"),
                ));
            }
            if tail.starts_with("was idle at exit; not revived") {
                return Some(worker_event(
                    entry,
                    IncidentSeverity::Info,
                    IncidentCategory::Recovery,
                    IncidentEventClass::RecoveryAction,
                    id,
                    format!("session worker {id} was idle at exit; not revived (reopens on the next client open)"),
                ));
            }
            if let Some(reason) = tail.strip_prefix("not revived: ") {
                return Some(worker_event(
                    entry,
                    IncidentSeverity::Warn,
                    IncidentCategory::Recovery,
                    IncidentEventClass::RecoveryFailure,
                    id,
                    format!(
                        "session worker {id} not revived: {}",
                        truncate_text(reason, 100)
                    ),
                ));
            }
            if let Some(children) = tail
                .strip_prefix("died with ")
                .and_then(|rest| rest.split_once(" resident RLM child(ren)"))
            {
                return Some(worker_event(
                    entry,
                    IncidentSeverity::Warn,
                    IncidentCategory::Recovery,
                    IncidentEventClass::RecoveryAction,
                    id,
                    format!("session worker {id} died with {children} resident RLM child(ren); closed with the parent"),
                ));
            }
            if let Some(error) = tail.strip_prefix("give-up journal settle failed: ") {
                return Some(worker_event(
                    entry,
                    IncidentSeverity::Warn,
                    IncidentCategory::Recovery,
                    IncidentEventClass::RecoveryFailure,
                    id,
                    format!(
                        "session worker {id} give-up journal settle failed: {}",
                        truncate_text(error, 100)
                    ),
                ));
            }
        }
    }

    if let Some(id) = msg
        .strip_prefix("finished the tombstoned stop of session worker ")
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        return Some(worker_event(
            entry,
            IncidentSeverity::Info,
            IncidentCategory::Recovery,
            IncidentEventClass::RecoveryAction,
            id,
            format!("finished the tombstoned stop of session worker {id}"),
        ));
    }
    if let Some(id) = msg
        .strip_prefix("tombstoned stop of session worker ")
        .and_then(|rest| rest.strip_suffix(" not settled; descriptor kept"))
    {
        return Some(worker_event(
            entry,
            IncidentSeverity::Warn,
            IncidentCategory::Recovery,
            IncidentEventClass::RecoveryFailure,
            id,
            format!("tombstoned stop of session worker {id} not settled; descriptor kept"),
        ));
    }
    if let Some(rest) = msg.strip_prefix("adopted session worker ") {
        if let Some(id) = rest.split_once(" (was alive: ").map(|(id, _)| id) {
            let alive = rest.ends_with("(was alive: true)");
            return Some(worker_event(
                entry,
                IncidentSeverity::Info,
                IncidentCategory::Recovery,
                IncidentEventClass::RecoveryAction,
                id,
                format!("adopted session worker {id} (was alive: {alive})"),
            ));
        }
        if let Some(id) = rest.strip_suffix(" via self-registration") {
            return Some(worker_event(
                entry,
                IncidentSeverity::Info,
                IncidentCategory::Recovery,
                IncidentEventClass::RecoveryAction,
                id,
                format!("adopted session worker {id} via self-registration"),
            ));
        }
    }
    if let Some(id) = msg
        .strip_prefix("session worker ")
        .and_then(|rest| rest.strip_suffix(" already registered; skipping descriptor adoption"))
    {
        return Some(worker_event(
            entry,
            IncidentSeverity::Info,
            IncidentCategory::Recovery,
            IncidentEventClass::RecoveryAction,
            id,
            format!("session worker {id} already registered; skipped descriptor adoption"),
        ));
    }
    if let Some((id, error)) = msg
        .strip_prefix("could not adopt worker ")
        .and_then(|rest| rest.split_once(": "))
    {
        return Some(worker_event(
            entry,
            IncidentSeverity::Warn,
            IncidentCategory::Recovery,
            IncidentEventClass::RecoveryFailure,
            id,
            format!("could not adopt worker {id}: {}", truncate_text(error, 100)),
        ));
    }
    if let Some((id, error)) = msg
        .strip_prefix("worker ")
        .and_then(|rest| rest.split_once(" relaunch failed: "))
    {
        return Some(worker_event(
            entry,
            IncidentSeverity::Error,
            IncidentCategory::Recovery,
            IncidentEventClass::RecoveryFailure,
            id,
            format!("worker {id} relaunch failed: {}", truncate_text(error, 100)),
        ));
    }

    // Update flow: the exit line is the supervisor replacement (an update
    // relaunch); an abandoned or aborted update never exited.
    if let Some(rest) = msg.strip_prefix("update ") {
        if let Some((update_id, stopped)) = rest
            .strip_suffix(" worker(s) stopped; exiting for the update")
            .and_then(|prefix| prefix.split_once(": all"))
        {
            let stopped = stopped.trim();
            return Some(event(
                entry,
                IncidentSeverity::Info,
                IncidentCategory::Supervisor,
                IncidentEventClass::SupervisorRestart,
                daemon_subject,
                format!("daemon restarting for update {update_id} ({stopped} worker(s) stopped)"),
                collect_tokens(update_id),
            ));
        }
        if let Some((update_id, reason)) = rest.split_once(" abandoned: ") {
            return Some(event(
                entry,
                IncidentSeverity::Warn,
                IncidentCategory::Supervisor,
                IncidentEventClass::Diagnostic,
                daemon_subject,
                format!(
                    "update {update_id} abandoned: {}",
                    truncate_text(reason, 100)
                ),
                collect_tokens(update_id),
            ));
        }
    }
    if let Some((phase, reason)) = msg
        .strip_prefix("update prepare aborted (")
        .and_then(|rest| rest.rsplit_once("): "))
    {
        return Some(event(
            entry,
            IncidentSeverity::Warn,
            IncidentCategory::Supervisor,
            IncidentEventClass::Diagnostic,
            format!("daemon {}", entry.daemon),
            format!(
                "update prepare aborted ({phase}): {}",
                truncate_text(reason, 100)
            ),
            Vec::new(),
        ));
    }

    // Provider stream failures (the incident-enrichment lane's worker sink
    // writes these into the daemon log): anomalies attributed to the
    // session named on the line.
    if let Some(rest) = msg.strip_prefix("provider stream failure (") {
        if let Some((kind_status, session)) = rest.split_once(") for session ") {
            let kind = kind_status
                .split(", ")
                .next()
                .and_then(|first| first.strip_prefix("kind "))
                .unwrap_or("unknown");
            let status = kind_status
                .rsplit_once(", status ")
                .map(|(_, status)| format!(" {status}"))
                .unwrap_or_default();
            let subject = format!("session {session}");
            return Some(event(
                entry,
                IncidentSeverity::Error,
                IncidentCategory::Anomaly,
                IncidentEventClass::Provider,
                subject.clone(),
                format!("provider stream failure ({kind}{status}) for session {session}"),
                collect_tokens(session),
            ));
        }
    }

    // Create refusals: supervisor-level command failures naming the
    // refused session in the headline.
    for prefix in [
        "create refused: ",
        "create refused \u{2014} ",
        "relaunch create refused \u{2014} ",
    ] {
        if let Some(headline) = msg.strip_prefix(prefix) {
            return Some(event(
                entry,
                IncidentSeverity::Warn,
                IncidentCategory::Supervisor,
                IncidentEventClass::CommandFailure,
                daemon_subject.clone(),
                format!("{prefix}{}", truncate_text(headline, 100)),
                collect_tokens(headline),
            ));
        }
    }

    if let Some((stale, current)) = msg
        .strip_prefix("rebinding stale session id ")
        .and_then(|rest| rest.split_once(" -> "))
    {
        let subject = format!("session {current}");
        return Some(event(
            entry,
            IncidentSeverity::Info,
            IncidentCategory::Supervisor,
            IncidentEventClass::SupervisorAction,
            subject.clone(),
            format!("rebound stale session id {stale} to {current}"),
            collect_tokens(&format!("{stale} {current}")),
        ));
    }

    // Boot hygiene: leftover reaps are recovery actions.
    if msg.starts_with("boot reap: ") || msg.starts_with("give-up sweep: ") {
        return Some(event(
            entry,
            if msg.starts_with("give-up") {
                IncidentSeverity::Warn
            } else {
                IncidentSeverity::Info
            },
            IncidentCategory::Recovery,
            IncidentEventClass::RecoveryAction,
            daemon_subject.clone(),
            truncate_text(msg, SUMMARY_TRUNCATION),
            collect_tokens(msg),
        ));
    }

    // Unknown-but-failing diagnostics still matter during an incident:
    // degrade them to a readable per-line summary instead of dropping them
    // (the TS generic-diagnostic fallthrough, matched to rust's log
    // shapes: no level/component field, so the failure is in the wording).
    if [
        "failed to ",
        "failed after ",
        "could not ",
        "Could not ",
        "cannot ",
    ]
    .iter()
    .any(|prefix| msg.starts_with(prefix))
    {
        return Some(event(
            entry,
            IncidentSeverity::Warn,
            IncidentCategory::Supervisor,
            IncidentEventClass::Diagnostic,
            daemon_subject.clone(),
            truncate_text(msg, SUMMARY_TRUNCATION),
            collect_tokens(msg),
        ));
    }

    None
}

/// Classify every entry (the TS `collectIncidentEvents`; rust's daemon
/// logs each event once — one writer per daemon log — so the TS
/// cross-component lifecycle dedupe has nothing to dedupe here).
pub fn collect_incident_events(entries: &[IncidentLogEntry]) -> Vec<IncidentEvent> {
    entries.iter().filter_map(classify_incident_entry).collect()
}

// ---------------------------------------------------------------------------
// Anomaly computation
// ---------------------------------------------------------------------------

/// The densest run of time-sorted events within `window_ms` of each other
/// (the TS `densestWindowRun`): only events close together form one
/// incident, so isolated events far apart never merge.
fn densest_window_run(items: &[&IncidentEvent], window_ms: i64) -> (usize, usize) {
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

/// The burst-class events: several close-together failures read as one
/// incident, so they feed the burst scan (the TS `BURST_CLASSES`).
fn is_burst_class(class: IncidentEventClass) -> bool {
    matches!(
        class,
        IncidentEventClass::CommandFailure
            | IncidentEventClass::Auth
            | IncidentEventClass::Diagnostic
    )
}

/// Compute the stall, error-burst, and event-gap anomaly lines from the
/// classified events (the TS `computeIncidentAnomalies`).
pub fn compute_incident_anomalies(events: &[IncidentEvent]) -> Vec<IncidentEvent> {
    let mut by_subject: HashMap<&str, Vec<&IncidentEvent>> = HashMap::new();
    for incident in events {
        if incident.category == IncidentCategory::Anomaly {
            continue;
        }
        by_subject
            .entry(incident.subject.as_str())
            .or_default()
            .push(incident);
    }

    let mut anomalies: Vec<IncidentEvent> = Vec::new();
    let mut push = |time_ms: i64, severity: IncidentSeverity, subject: &str, summary: String| {
        anomalies.push(IncidentEvent {
            time_ms,
            severity,
            category: IncidentCategory::Anomaly,
            event_class: IncidentEventClass::Anomaly,
            subject: subject.to_string(),
            summary,
            tokens: Vec::new(),
        });
    };

    for (subject, group) in &by_subject {
        let mut group: Vec<&IncidentEvent> = group.clone();
        group.sort_by_key(|incident| incident.time_ms);

        let timeouts: Vec<&IncidentEvent> = group
            .iter()
            .filter(|incident| incident.event_class == IncidentEventClass::Timeout)
            .copied()
            .collect();
        if timeouts.len() >= 2 {
            let (start, count) = densest_window_run(&timeouts, TIMEOUT_STALL_WINDOW_MS);
            if count >= 2 {
                let cluster = &timeouts[start..start + count];
                let span = cluster[cluster.len() - 1].time_ms - cluster[0].time_ms;
                push(
                    cluster[0].time_ms,
                    IncidentSeverity::Error,
                    subject,
                    format!(
                        "{subject}: {} command timeouts over {}",
                        cluster.len(),
                        format_incident_duration(span)
                    ),
                );
            }
        }

        let burst: Vec<&IncidentEvent> = group
            .iter()
            .filter(|incident| is_burst_class(incident.event_class))
            .copied()
            .collect();
        if burst.len() >= ERROR_BURST_THRESHOLD {
            let (start, count) = densest_window_run(&burst, ERROR_BURST_WINDOW_MS);
            if count >= ERROR_BURST_THRESHOLD {
                let cluster = &burst[start..start + count];
                let span = cluster[cluster.len() - 1].time_ms - cluster[0].time_ms;
                let severity = cluster
                    .iter()
                    .map(|incident| incident.severity)
                    .max()
                    .unwrap_or(IncidentSeverity::Warn);
                push(
                    cluster[0].time_ms,
                    severity,
                    subject,
                    format!(
                        "{subject}: {} warnings/errors over {}",
                        cluster.len(),
                        format_incident_duration(span)
                    ),
                );
            }
        }

        if subject.starts_with("session ") {
            for pair in group.windows(2) {
                let gap = pair[1].time_ms - pair[0].time_ms;
                if gap >= STALL_GAP_MS {
                    push(
                        pair[0].time_ms,
                        IncidentSeverity::Warn,
                        subject,
                        format!(
                            "{subject}: {} event gap (no logged events)",
                            format_incident_duration(gap)
                        ),
                    );
                }
            }
        }
    }
    anomalies.sort_by_key(|anomaly| anomaly.time_ms);
    anomalies
}

/// Per subject, the latest timeout of the stall cluster
/// [`compute_incident_anomalies`] reports (the TS
/// `latestIncidentStallTimeoutBySubject`): the agents-view notice anchors
/// its dismissal horizon there, so a later timeout extending the burst
/// re-surfaces the notice while an isolated stray timeout never does.
pub fn latest_stall_timeout_by_subject(events: &[IncidentEvent]) -> HashMap<String, i64> {
    let mut timeouts_by_subject: HashMap<&str, Vec<&IncidentEvent>> = HashMap::new();
    for incident in events {
        if incident.event_class != IncidentEventClass::Timeout {
            continue;
        }
        timeouts_by_subject
            .entry(incident.subject.as_str())
            .or_default()
            .push(incident);
    }
    let mut latest = HashMap::new();
    for (subject, timeouts) in &timeouts_by_subject {
        let mut sorted: Vec<&IncidentEvent> = timeouts.clone();
        sorted.sort_by_key(|incident| incident.time_ms);
        let (start, count) = densest_window_run(&sorted, TIMEOUT_STALL_WINDOW_MS);
        if count >= 2 {
            latest.insert(subject.to_string(), sorted[start + count - 1].time_ms);
        }
    }
    latest
}

// ---------------------------------------------------------------------------
// Timeline rendering
// ---------------------------------------------------------------------------

/// One aggregated timeline row: identical events collapse with a count
/// and a last-seen timestamp (the TS `aggregateIncidentEvents`).
struct AggregatedEvent<'a> {
    first: &'a IncidentEvent,
    last_time_ms: i64,
    count: usize,
}

/// Aggregate a section's events: identical (category, subject, summary)
/// triples collapse, ordered by first occurrence.
fn aggregate_incident_events<'a>(events: &[&'a IncidentEvent]) -> Vec<AggregatedEvent<'a>> {
    let mut order: Vec<AggregatedEvent<'a>> = Vec::new();
    let mut index: HashMap<(&'a str, &'a str, &'a str), usize> = HashMap::new();
    for incident in events {
        let key = (
            incident.category.as_str(),
            incident.subject.as_str(),
            incident.summary.as_str(),
        );
        match index.get(&key).copied() {
            Some(position) => {
                let group = &mut order[position];
                group.last_time_ms = group.last_time_ms.max(incident.time_ms);
                group.count += 1;
            }
            None => {
                index.insert(key, order.len());
                order.push(AggregatedEvent {
                    first: incident,
                    last_time_ms: incident.time_ms,
                    count: 1,
                });
            }
        }
    }
    order.sort_by_key(|group| group.first.time_ms);
    order
}

/// An incident event matches the `--session` filter when one of its tokens
/// prefixes the filter or the filter prefixes the token (the TS
/// `sessionMatches`; an empty token never matches).
fn session_matches(incident: &IncidentEvent, session: &str) -> bool {
    incident.tokens.iter().any(|token| {
        !token.is_empty() && (token.starts_with(session) || session.starts_with(token))
    })
}

/// The full incident timeline text for a window (the TS
/// `buildIncidentReport`): classified events grouped into the three
/// sections, repeated identical events aggregated with counts, and
/// per-subject stalls, bursts, and gaps surfaced as anomalies.
pub fn build_incident_report(
    entries: &[IncidentLogEntry],
    options: &IncidentReportOptions<'_>,
) -> String {
    let all_events = collect_incident_events(entries);
    let window = options.window;
    let in_window: Vec<IncidentEvent> = all_events
        .iter()
        .filter(|incident| {
            incident.time_ms >= window.since_ms && incident.time_ms <= window.until_ms
        })
        .cloned()
        .collect();
    let events_in_window = in_window.len();

    let mut events = in_window;
    let mut filtered_by_session = false;
    if let Some(session) = options.session {
        if !events.is_empty() {
            let matching: Vec<IncidentEvent> = events
                .into_iter()
                .filter(|incident| session_matches(incident, session))
                .collect();
            if matching.is_empty() {
                return format!(
                    "No daemon events between {} and {} UTC reference session \"{session}\".",
                    format_incident_time(window.since_ms),
                    format_incident_time(window.until_ms)
                );
            }
            events = matching;
            filtered_by_session = true;
        }
    }

    // The computed anomalies ride the raw events: provider failures (raw
    // anomaly events) stay in the timeline, and the stall/burst/gap scan
    // runs over the non-anomaly remainder (the TS `buildIncidentReport`).
    let classified: Vec<IncidentEvent> = events
        .iter()
        .filter(|incident| incident.category != IncidentCategory::Anomaly)
        .cloned()
        .collect();
    let mut timeline_events = events;
    timeline_events.extend(compute_incident_anomalies(&classified));

    let mut text = String::from("Prime Agent incident timeline\n");
    text.push_str(&format!(
        "Window: {} \u{2192} {} UTC ({})\n",
        format_incident_time(window.since_ms),
        format_incident_time(window.until_ms),
        format_incident_duration(window.until_ms - window.since_ms)
    ));
    if let Some(source) = options.source {
        let skipped_text = if source.skipped_count > 0 {
            format!(", {} unreadable skipped", source.skipped_count)
        } else {
            String::new()
        };
        text.push_str(&format!(
            "Source: {} ({} lines scanned, {events_in_window} events in window{skipped_text})\n",
            source.source, source.scanned_count
        ));
    }
    if filtered_by_session {
        text.push_str(&format!(
            "Session filter: {}\n",
            options.session.unwrap_or_default()
        ));
    }

    for category in [
        IncidentCategory::Supervisor,
        IncidentCategory::Anomaly,
        IncidentCategory::Recovery,
    ] {
        text.push('\n');
        text.push_str(category.title());
        text.push('\n');
        let section: Vec<&IncidentEvent> = timeline_events
            .iter()
            .filter(|incident| incident.category == category)
            .collect();
        let aggregated = aggregate_incident_events(&section);
        if aggregated.is_empty() {
            text.push_str("  \x1b[2m(none)\x1b[22m\n");
            continue;
        }
        for group in aggregated {
            let suffix = if group.count > 1 {
                format!(
                    " (x{}, until {})",
                    group.count,
                    format_incident_time(group.last_time_ms)
                )
            } else {
                String::new()
            };
            text.push_str(&format!(
                "  {}  {}  {}{}\n",
                format_incident_time(group.first.time_ms),
                group
                    .first
                    .severity
                    .colorize(&format!("{:8}", group.first.severity.as_str())),
                group.first.summary,
                suffix
            ));
        }
    }
    text.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(time_ms: i64, msg: &str) -> IncidentLogEntry {
        IncidentLogEntry {
            time_ms,
            daemon: "prime-agent.sock.a1b2c3d4".to_string(),
            msg: msg.to_string(),
        }
    }

    fn events(entries: &[IncidentLogEntry]) -> Vec<IncidentEvent> {
        collect_incident_events(entries)
    }

    #[test]
    fn parses_daemon_log_lines() {
        let parsed = parse_daemon_log_line(
            "[2026-09-10T20:02:30.123Z] session worker 5b1d3aeb91ee exited unexpectedly; restarting in 250ms (failure 1/5)",
            "prime-agent.sock.a1b2c3d4",
        )
        .expect("valid line");
        assert_eq!(parsed.time_ms, utc_ms(2026, 9, 10, 20, 2, 30, 123));
        assert_eq!(parsed.daemon, "prime-agent.sock.a1b2c3d4");
        assert!(parsed.msg.starts_with("session worker 5b1d3aeb91ee"));
        // Malformed shapes drop, not panic.
        assert!(parse_daemon_log_line("no timestamp here", "d").is_none());
        assert!(parse_daemon_log_line("[not-a-time] msg", "d").is_none());
        assert!(parse_daemon_log_line("[2026-09-10T20:02:30.123Z]   ", "d").is_none());
    }

    #[test]
    fn rfc3339_and_civil_round_trip() {
        let ms = parse_rfc3339_ms("2026-09-10T20:02:30.123Z").expect("timestamp");
        assert_eq!(format_incident_time(ms), "09-10 20:02:30");
        assert_eq!(parse_rfc3339_ms("2026-02-30T00:00:00.000Z"), None);
        assert_eq!(parse_rfc3339_ms("2026-09-10T25:00:00.000Z"), None);
        let offset = parse_rfc3339_ms("2026-09-10T20:02:30+01:00").expect("offset timestamp");
        assert_eq!(
            offset,
            parse_rfc3339_ms("2026-09-10T19:02:30.000Z").expect("utc")
        );
        assert_eq!(
            parse_rfc3339_ms("2026-09-10T20:02:30.7Z").expect("fraction"),
            utc_ms(2026, 9, 10, 20, 2, 30, 700)
        );
    }

    #[test]
    fn time_bounds_parse_like_the_cli() {
        let now = parse_rfc3339_ms("2026-09-24T12:34:56.000Z").expect("now");
        assert_eq!(
            parse_incident_time_bound("20:02", now, "--since").unwrap(),
            utc_ms(2026, 9, 24, 20, 2, 0, 0)
        );
        assert_eq!(
            parse_incident_time_bound("2026-09-16", now, "--since").unwrap(),
            utc_ms(2026, 9, 16, 0, 0, 0, 0)
        );
        assert_eq!(
            parse_incident_time_bound("2026-09-16T20:02", now, "--since").unwrap(),
            utc_ms(2026, 9, 16, 20, 2, 0, 0)
        );
        assert!(parse_incident_time_bound("", now, "--since").is_err());
        assert!(parse_incident_time_bound("yesterday", now, "--since").is_err());
        assert!(parse_incident_time_bound("99:99", now, "--since").is_err());
        assert!(parse_incident_time_bound("2026-02-30", now, "--since").is_err());
        assert!(resolve_incident_window(
            &IncidentCommandOptions {
                since: Some("09-16".to_string()),
                until: None,
                session: None,
            },
            now
        )
        .is_err());
        assert!(
            resolve_incident_window(
                &IncidentCommandOptions {
                    since: Some("2026-09-23T12:34:56".to_string()),
                    until: Some("2026-09-23T12:34:56".to_string()),
                    session: None,
                },
                now
            )
            .is_err(),
            "--until must be after --since"
        );
        let window = resolve_incident_window(&IncidentCommandOptions::default(), now).unwrap();
        assert_eq!(window.until_ms - window.since_ms, DEFAULT_WINDOW_MS);
    }

    #[test]
    fn classifies_worker_lifecycle() {
        let classified = events(&[
            entry(1_000, "session worker 5b1d3aeb91ee registered (epoch 1, pid 4242)"),
            entry(2_000, "session worker 5b1d3aeb91ee re-registered (epoch 2, pid 4545)"),
            entry(
                3_000,
                "session worker 5b1d3aeb91ee stopped intentionally (status ExitStatus(unix_wait_status(0)))",
            ),
        ]);
        assert_eq!(classified[0].event_class, IncidentEventClass::WorkerStart);
        assert_eq!(classified[0].severity, IncidentSeverity::Info);
        assert_eq!(
            classified[0].summary,
            "session worker 5b1d3aeb91ee registered (epoch 1)"
        );
        assert_eq!(
            classified[1].summary,
            "session worker 5b1d3aeb91ee re-registered (epoch 2)"
        );
        assert_eq!(classified[2].event_class, IncidentEventClass::WorkerStop);
        assert_eq!(
            classified[2].summary,
            "session worker 5b1d3aeb91ee stopped intentionally"
        );
        assert!(classified[0].tokens.contains(&"5b1d3aeb91ee".to_string()));
    }

    #[test]
    fn classifies_worker_crash_and_restart() {
        let classified = events(&[entry(
            1_000,
            "session worker 5b1d3aeb91ee exited unexpectedly; restarting in 250ms (failure 2/5)",
        )]);
        assert_eq!(classified[0].event_class, IncidentEventClass::WorkerCrash);
        assert_eq!(classified[0].severity, IncidentSeverity::Critical);
        assert_eq!(classified[0].category, IncidentCategory::Supervisor);
        assert_eq!(classified[0].subject, "worker 5b1d3aeb91ee");
    }

    #[test]
    fn classifies_command_timeouts() {
        // The incident-enrichment lane's supervisor line; the arm pins its
        // shape so that follow-up only has to start writing it.
        let classified = events(&[entry(
            1_000,
            "session worker 5b1d3aeb91ee command attach timed out after 30000ms",
        )]);
        assert_eq!(classified[0].event_class, IncidentEventClass::Timeout);
        assert_eq!(classified[0].severity, IncidentSeverity::Error);
        assert_eq!(
            classified[0].summary,
            "command attach timed out on session worker 5b1d3aeb91ee after 30000ms"
        );
    }

    #[test]
    fn classifies_auth_failures() {
        let classified = events(&[entry(
            1_000,
            "session worker 5b1d3aeb91ee authentication failed: token mismatch",
        )]);
        assert_eq!(classified[0].event_class, IncidentEventClass::Auth);
        assert_eq!(classified[0].severity, IncidentSeverity::Error);
        assert!(classified[0]
            .summary
            .contains("authentication failed: token mismatch"));
    }

    #[test]
    fn classifies_provider_stream_failures() {
        let classified = events(&[
            entry(
                1_000,
                "provider stream failure (kind rate_limit, status 429) for session 2339fb7da605",
            ),
            entry(
                2_000,
                "provider stream failure (kind server_error) for session 2339fb7da605",
            ),
        ]);
        assert_eq!(classified[0].event_class, IncidentEventClass::Provider);
        assert_eq!(classified[0].category, IncidentCategory::Anomaly);
        assert_eq!(
            classified[0].summary,
            "provider stream failure (rate_limit 429) for session 2339fb7da605"
        );
        assert_eq!(
            classified[1].summary,
            "provider stream failure (server_error) for session 2339fb7da605"
        );
        assert!(classified[0].tokens.contains(&"2339fb7da605".to_string()));
    }

    #[test]
    fn classifies_recovery_actions() {
        let classified = events(&[
            entry(1_000, "adopted session worker 5b1d3aeb91ee (was alive: true)"),
            entry(2_000, "adopted session worker 5b1d3aeb91ee via self-registration"),
            entry(
                3_000,
                "session worker 5b1d3aeb91ee already registered; skipping descriptor adoption",
            ),
            entry(
                4_000,
                "session worker 5b1d3aeb91ee was idle at exit; not revived (reopens on the next client open)",
            ),
            entry(5_000, "finished the tombstoned stop of session worker 5b1d3aeb91ee"),
            entry(6_000, "boot reap: 2 same-socket predecessor process(es) to clear"),
            entry(
                7_000,
                "give-up sweep: 1 leftover process(es) of session worker 5b1d3aeb91ee",
            ),
            entry(
                8_000,
                "session worker 5b1d3aeb91ee died with 2 resident RLM child(ren); closing them with the parent",
            ),
        ]);
        assert_eq!(classified.len(), 8);
        for classified in &classified {
            assert_eq!(
                classified.category,
                IncidentCategory::Recovery,
                "{}",
                classified.summary
            );
            assert_eq!(classified.event_class, IncidentEventClass::RecoveryAction);
        }
    }

    #[test]
    fn classifies_recovery_failures() {
        let classified = events(&[
            entry(
                1_000,
                "could not adopt worker 5b1d3aeb91ee: supervisor is shutting down",
            ),
            entry(2_000, "worker 5b1d3aeb91ee relaunch failed: spawn failed"),
            entry(
                3_000,
                "session worker 5b1d3aeb91ee failed after 5 consecutive failures",
            ),
            entry(
                4_000,
                "session worker 5b1d3aeb91ee not revived: create was refused",
            ),
            entry(
                5_000,
                "tombstoned stop of session worker 5b1d3aeb91ee not settled; descriptor kept",
            ),
            entry(
                6_000,
                "session worker 5b1d3aeb91ee give-up journal settle failed: journal unreadable",
            ),
        ]);
        assert_eq!(classified.len(), 6);
        assert!(classified.iter().all(|incident| {
            incident.category == IncidentCategory::Recovery
                && incident.event_class == IncidentEventClass::RecoveryFailure
                && incident.severity >= IncidentSeverity::Warn
        }));
    }

    #[test]
    fn classifies_update_exits_as_supervisor_replacement() {
        let classified = events(&[
            entry(1_000, "update 7f3c: all 3 worker(s) stopped; exiting for the update"),
            entry(
                2_000,
                "update 7f3c: abandoned: worker(s) [\"5b1d3aeb91ee\"] did not stop in budget; sessions untouched",
            ),
            entry(
                3_000,
                "update prepare aborted (drain): Timed out draining daemon mutations for update restart",
            ),
        ]);
        assert_eq!(
            classified[0].event_class,
            IncidentEventClass::SupervisorRestart
        );
        assert_eq!(classified[0].severity, IncidentSeverity::Info);
        assert!(classified[0].summary.contains("restarting for update 7f3c"));
        assert_eq!(classified[1].event_class, IncidentEventClass::Diagnostic);
        assert_eq!(classified[1].severity, IncidentSeverity::Warn);
        assert_eq!(classified[2].event_class, IncidentEventClass::Diagnostic);
    }

    #[test]
    fn classifies_create_refusals_and_rebinding() {
        let classified = events(&[
            entry(1_000, "create refused \u{2014} session file already active"),
            entry(
                2_000,
                "create refused: session file /tmp/a/2339fb7da605.jsonl is already active (worker 5b1d3aeb91ee) \u{2014} attach instead",
            ),
            entry(3_000, "relaunch create refused \u{2014} create replay failed"),
            entry(4_000, "rebinding stale session id 2339fb7da605 -> 2339fb7da605-2"),
        ]);
        assert_eq!(
            classified[0].event_class,
            IncidentEventClass::CommandFailure
        );
        assert_eq!(classified[0].severity, IncidentSeverity::Warn);
        assert_eq!(
            classified[1].event_class,
            IncidentEventClass::CommandFailure
        );
        assert!(classified[1]
            .tokens
            .iter()
            .any(|token| token.starts_with("2339fb7da605")));
        assert_eq!(
            classified[2].event_class,
            IncidentEventClass::CommandFailure
        );
        assert_eq!(
            classified[3].event_class,
            IncidentEventClass::SupervisorAction
        );
    }

    #[test]
    fn degrades_unknown_failures_and_drops_routine_noise() {
        let classified = events(&[
            entry(1_000, "failed to append RLM ledger spawn: disk full"),
            entry(
                2_000,
                "RLM ledger: skipped record with unknown op on line 3",
            ),
            entry(
                3_000,
                "session binding superseded: 2339fb7da605 -> 2339fb7da606 (file \"/tmp/a.jsonl\")",
            ),
        ]);
        assert_eq!(
            classified.len(),
            1,
            "unknown failures degrade; routine bookkeeping drops"
        );
        assert_eq!(classified[0].event_class, IncidentEventClass::Diagnostic);
        assert_eq!(
            classified[0].summary,
            "failed to append RLM ledger spawn: disk full"
        );
    }

    #[test]
    fn truncation_is_char_safe() {
        let long = "\u{e9}".repeat(200);
        let classified = events(&[entry(1_000, &format!("failed to do something: {long}"))]);
        assert_eq!(classified.len(), 1);
        assert!(classified[0].summary.ends_with("..."));
    }

    #[test]
    fn computes_timeout_stalls_only_when_close() {
        let timeouts: Vec<IncidentLogEntry> = (0..4)
            .map(|index| {
                entry(
                    1_000_000 + index * 60_000,
                    "session worker 5b1d3aeb91ee command attach timed out after 30000ms",
                )
            })
            .collect();
        let events = events(&timeouts);
        let anomalies = compute_incident_anomalies(&events);
        assert_eq!(anomalies.len(), 1);
        assert!(anomalies[0]
            .summary
            .starts_with("worker 5b1d3aeb91ee: 4 command timeouts over 3m"));

        // Two isolated timeouts hours apart never merge.
        let isolated = events(&[
            entry(
                0,
                "session worker 5b1d3aeb91ee command attach timed out after 30000ms",
            ),
            entry(
                6 * 60 * 60 * 1000,
                "session worker 5b1d3aeb91ee command attach timed out after 30000ms",
            ),
        ]);
        assert!(compute_incident_anomalies(&isolated).is_empty());
    }

    #[test]
    fn computes_error_bursts_only_when_close() {
        let burst: Vec<IncidentLogEntry> = (0..3)
            .map(|index| entry(1_000_000 + index * 60_000, "create refused \u{2014} busy"))
            .collect();
        let events = events(&burst);
        let anomalies = compute_incident_anomalies(&events);
        assert_eq!(anomalies.len(), 1);
        assert!(anomalies[0]
            .summary
            .starts_with("daemon prime-agent.sock.a1b2c3d4: 3 warnings/errors over 2m"));

        let spread = events(&[
            entry(0, "create refused \u{2014} busy"),
            entry(6 * 60 * 60 * 1000, "create refused \u{2014} busy"),
            entry(12 * 60 * 60 * 1000, "create refused \u{2014} busy"),
        ]);
        assert!(compute_incident_anomalies(&spread).is_empty());
    }

    #[test]
    fn latest_stall_timeout_anchors_the_cluster_tail() {
        let timeouts = events(&[
            entry(
                0,
                "session worker 5b1d3aeb91ee command attach timed out after 30000ms",
            ),
            entry(
                60_000,
                "session worker 5b1d3aeb91ee command attach timed out after 30000ms",
            ),
            entry(
                120_000,
                "session worker 5b1d3aeb91ee command attach timed out after 30000ms",
            ),
        ]);
        let latest = latest_stall_timeout_by_subject(&timeouts);
        assert_eq!(latest.get("worker 5b1d3aeb91ee"), Some(&120_000));
    }

    #[test]
    fn builds_the_timeline_report() {
        let base = utc_ms(2026, 9, 10, 20, 0, 0, 0);
        let entries = vec![
            entry(base, "session worker 5b1d3aeb91ee registered (epoch 1, pid 4242)"),
            entry(
                base + 150_000,
                "session worker 5b1d3aeb91ee command attach timed out after 30000ms",
            ),
            entry(
                base + 160_000,
                "session worker 5b1d3aeb91ee command attach timed out after 30000ms",
            ),
            entry(
                base + 170_000,
                "session worker 5b1d3aeb91ee command attach timed out after 30000ms",
            ),
            entry(
                base + 200_000,
                "session worker 5b1d3aeb91ee exited unexpectedly; restarting in 250ms (failure 1/5)",
            ),
            entry(base - 100_000, "create refused \u{2014} before the window"),
        ];
        let window = IncidentWindow {
            since_ms: base,
            until_ms: base + 3_600_000,
        };
        let text = build_incident_report(
            &entries,
            &IncidentReportOptions {
                window,
                session: None,
                source: None,
            },
        );
        assert!(
            text.starts_with(
                "Prime Agent incident timeline\nWindow: 09-10 20:00:00 \u{2192} 09-10 21:00:00 UTC (1h)"
            ),
            "{text}"
        );
        assert!(text.contains("Supervisor events\n  09-10 20:00:00"));
        assert!(
            text.contains("session worker 5b1d3aeb91ee registered (epoch 1)"),
            "{text}"
        );
        assert!(
            text.contains("(x3, until 09-10 20:02:50)"),
            "identical timeouts aggregate: {text}"
        );
        assert!(text.contains("Session anomalies"));
        assert!(text.contains("command timeouts over"));
        assert!(
            !text.contains("before the window"),
            "window filtering holds"
        );
        assert!(text.contains("Recovery"));
    }

    #[test]
    fn report_shows_none_placeholders_and_source_line() {
        let base = utc_ms(2026, 9, 10, 20, 0, 0, 0);
        let entries = vec![entry(
            base,
            "session worker 5b1d3aeb91ee registered (epoch 1, pid 1)",
        )];
        let window = IncidentWindow {
            since_ms: base,
            until_ms: base + 1_000,
        };
        let mut source = IncidentLogSource::default();
        source.scanned_count = 1;
        source.source = "prime-agent.sock.a1b2c3d4.log".to_string();
        source.skipped_count = 2;
        let text = build_incident_report(
            &entries,
            &IncidentReportOptions {
                window,
                session: None,
                source: Some(&source),
            },
        );
        assert!(text.contains("Source: prime-agent.sock.a1b2c3d4.log (1 lines scanned, 1 events in window, 2 unreadable skipped)"));
        assert!(text.contains("Session anomalies\n  \x1b[2m(none)\x1b[22m"));
    }

    #[test]
    fn filters_by_session_and_reports_no_match() {
        let base = utc_ms(2026, 9, 10, 20, 0, 0, 0);
        let entries = vec![entry(
            base,
            "session worker 5b1d3aeb91ee exited unexpectedly; restarting in 250ms (failure 1/5)",
        )];
        let window = IncidentWindow {
            since_ms: base,
            until_ms: base + 1_000,
        };
        let text = build_incident_report(
            &entries,
            &IncidentReportOptions {
                window,
                session: Some("5b1d3ae"),
                source: None,
            },
        );
        assert!(text.contains("Session filter: 5b1d3ae"));
        assert!(text.contains("session worker 5b1d3aeb91ee crashed"));

        let miss = build_incident_report(
            &entries,
            &IncidentReportOptions {
                window,
                session: Some("ffffffffffff"),
                source: None,
            },
        );
        assert!(miss.starts_with("No daemon events between"), "{miss}");
    }

    #[test]
    fn reads_daemon_logs_from_the_logs_dir() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).expect("logs dir");
        std::fs::write(
            logs.join("prime-agent.sock.a1b2c3d4.log"),
            "[2026-09-10T20:02:30.123Z] session worker 5b1d3aeb91ee registered (epoch 1, pid 1)\nnot a log line\n",
        )
        .expect("log");
        std::fs::write(
            logs.join("prime-agent.sock.a1b2c3d4.log.1"),
            "[2026-09-10T19:00:00.000Z] create refused \u{2014} rotated generation\n",
        )
        .expect("rotated log");
        std::fs::write(logs.join("notes.txt"), "ignore me\n").expect("noise");
        let source = read_incident_log_entries(&logs);
        assert_eq!(source.scanned_count, 3);
        assert_eq!(source.skipped_count, 1);
        assert_eq!(source.entries.len(), 2);
        assert_eq!(
            source.entries[0].msg,
            "create refused \u{2014} rotated generation"
        );
        assert_eq!(source.entries[0].daemon, "prime-agent.sock.a1b2c3d4");
        assert_eq!(
            source.entries[1].time_ms,
            utc_ms(2026, 9, 10, 20, 2, 30, 123)
        );
        assert_eq!(
            source.source,
            "prime-agent.sock.a1b2c3d4.log.1, prime-agent.sock.a1b2c3d4.log"
        );

        let newest = newest_daemon_log_path(&logs).expect("newest log");
        assert!(newest
            .to_string_lossy()
            .ends_with("prime-agent.sock.a1b2c3d4.log"));
        assert!(read_incident_log_entries(&logs.join("missing"))
            .entries
            .is_empty());
    }
}
