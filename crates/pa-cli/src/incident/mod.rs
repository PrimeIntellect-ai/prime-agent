//! `prime-agent incident`: reconstructs what the daemon did during a time
//! window from its diagnostic logs (the shared classifier lives in
//! `pa_types::incident`). The primary source is the shared structured log
//! (`~/.prime/agent/logs/agent.jsonl` plus its `.old` rotation); when it is
//! missing, empty, or unreadable, the newest per-daemon log is the fallback.

pub(crate) mod report;
pub(crate) mod time;

use self::report::{build_incident_report, IncidentReportOptions};
use crate::config::get_agent_dir;
use pa_types::incident::{
    parse_incident_daemon_log_line, parse_incident_log_line, IncidentLogEntry,
};
use std::path::{Path, PathBuf};

/// The default `--since` is 24 hours ago.
const DEFAULT_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct IncidentCommandOptions {
    pub(crate) since: Option<String>,
    pub(crate) until: Option<String>,
    pub(crate) session: Option<String>,
}

/// A usage error carrying the operator-facing message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IncidentUsageError(pub(crate) String);

impl std::fmt::Display for IncidentUsageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for IncidentUsageError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct IncidentWindow {
    pub(crate) since_ms: i64,
    pub(crate) until_ms: i64,
}

/// Parse `incident [--since <time>] [--until <time>] [--session <id>]` arguments.
///
/// # Errors
///
/// Returns [`IncidentUsageError`] for an unknown option or a missing/empty value.
pub(crate) fn parse_incident_options(
    args: &[String],
) -> Result<IncidentCommandOptions, IncidentUsageError> {
    let mut options = IncidentCommandOptions::default();
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        let mut name = arg;
        let mut value: Option<String> = None;
        if arg.starts_with("--") {
            if let Some(equals_index) = arg.find('=') {
                name = &arg[..equals_index];
                value = Some(arg[equals_index + 1..].to_string());
            }
        }
        if !matches!(name, "--since" | "--until" | "--session") {
            return Err(IncidentUsageError(format!(
                "Unknown option for incident: {arg}"
            )));
        }
        let value = if let Some(value) = value {
            value
        } else {
            let Some(next) = args.get(index + 1) else {
                return Err(IncidentUsageError(format!(
                    "Option {name} requires a value."
                )));
            };
            index += 1;
            next.clone()
        };
        if value.trim().is_empty() {
            return Err(IncidentUsageError(format!(
                "Option {name} requires a value."
            )));
        }
        match name {
            "--since" => options.since = Some(value),
            "--until" => options.until = Some(value),
            "--session" => options.session = Some(value),
            _ => unreachable!("the option names are matched above"),
        }
        index += 1;
    }
    Ok(options)
}

/// Resolve `--since`/`--until` (default: last 24h until now) (TS `resolveIncidentWindow`).
///
/// # Errors
///
/// Returns [`IncidentUsageError`] for a bad bound or an unordered window.
pub(crate) fn resolve_incident_window(
    options: &IncidentCommandOptions,
    now_ms: i64,
) -> Result<IncidentWindow, IncidentUsageError> {
    let since_ms = match options.since.as_deref() {
        Some(since) => time::parse_incident_time_bound(since, now_ms, "--since")?,
        None => now_ms - DEFAULT_WINDOW_MS,
    };
    let until_ms = match options.until.as_deref() {
        Some(until) => time::parse_incident_time_bound(until, now_ms, "--until")?,
        None => now_ms,
    };
    if until_ms <= since_ms {
        return Err(IncidentUsageError(
            "--until must be after --since.".to_string(),
        ));
    }
    Ok(IncidentWindow { since_ms, until_ms })
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct IncidentLogSource {
    pub(crate) entries: Vec<IncidentLogEntry>,
    pub(crate) scanned_count: usize,
    pub(crate) skipped_count: usize,
    pub(crate) source: String,
}

enum IncidentLogFileKind {
    /// `agent.jsonl` (and its `.old` rotation): one JSON object per line.
    Jsonl,
    /// A per-daemon log: `[<ISO>] supervisor: <msg>` plain-text lines.
    Daemon,
}

fn incident_logs_dir() -> PathBuf {
    get_agent_dir().join("logs")
}

/// Read the daemon logs: agent.jsonl (plus its `.old` rotation) when it yields
/// entries, otherwise the newest per-daemon log (rotated generations excluded).
pub(crate) fn read_incident_log_entries() -> IncidentLogSource {
    let logs_dir = incident_logs_dir();
    let agent_log_path = logs_dir.join("agent.jsonl");
    let agent_log_old = PathBuf::from(format!("{}.old", agent_log_path.display()));
    let structured_files = [&agent_log_old, &agent_log_path]
        .into_iter()
        .filter(|path| path.exists())
        .map(|path| (path.clone(), IncidentLogFileKind::Jsonl))
        .collect::<Vec<_>>();
    let structured = scan_incident_log_files(&structured_files);
    if !structured.entries.is_empty() {
        return structured;
    }
    // agent.jsonl is missing, empty, or unreadable: fall back to the
    // newest per-daemon log. Window filtering happens later.
    let Some(fallback_path) = newest_daemon_log_path(&logs_dir) else {
        return structured;
    };
    let fallback = scan_incident_log_files(&[(fallback_path, IncidentLogFileKind::Daemon)]);
    if fallback.entries.is_empty() {
        structured
    } else {
        fallback
    }
}

/// Scan every non-empty line of the files; unreadable files are skipped
/// whole.
fn scan_incident_log_files(files: &[(PathBuf, IncidentLogFileKind)]) -> IncidentLogSource {
    let mut entries: Vec<IncidentLogEntry> = Vec::new();
    let mut scanned_count = 0;
    let mut skipped_count = 0;
    for (path, kind) in files {
        // A torn multi-byte write at the live log's tail must not cost the whole scan:
        // decode lossily and let the torn line itself fail the parse.
        let Ok(bytes) = std::fs::read(path) else {
            continue;
        };
        let contents = String::from_utf8_lossy(&bytes);
        for line in contents.split('\n') {
            if line.trim().is_empty() {
                continue;
            }
            scanned_count += 1;
            let entry = match kind {
                IncidentLogFileKind::Jsonl => parse_incident_log_line(line),
                IncidentLogFileKind::Daemon => parse_incident_daemon_log_line(line),
            };
            match entry {
                Some(entry) => entries.push(entry),
                None => skipped_count += 1,
            }
        }
    }
    IncidentLogSource {
        entries,
        scanned_count,
        skipped_count,
        source: files
            .iter()
            .map(|(path, _)| path.display().to_string())
            .collect::<Vec<_>>()
            .join(", "),
    }
}

/// The newest per-daemon log file in the logs directory, skipping non-file
/// entries (a matching directory would hide older valid logs).
fn newest_daemon_log_path(logs_dir: &Path) -> Option<PathBuf> {
    let names = std::fs::read_dir(logs_dir).ok()?;
    let mut candidates: Vec<(PathBuf, i128)> = Vec::new();
    for name in names {
        let Ok(name) = name else {
            continue;
        };
        let file_name = name.file_name();
        if !is_daemon_log_file_name(&file_name.to_string_lossy()) {
            continue;
        }
        let path = logs_dir.join(&file_name);
        let Ok(stat) = std::fs::metadata(&path) else {
            // Lost a race with log rotation or permissions; skip it.
            continue;
        };
        if !stat.is_file() {
            continue;
        }
        let Some(mtime) = mtime_ms(&stat) else {
            continue;
        };
        candidates.push((path, mtime));
    }
    candidates.sort_by_key(|a| std::cmp::Reverse(a.1));
    candidates.first().map(|(path, _)| path.clone())
}

/// `<socket basename>.<hash8>.log`: the socket basename itself may lack `.sock`
/// for custom sockets and Windows named pipes.
fn is_daemon_log_file_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".log") else {
        return false;
    };
    let bytes = stem.as_bytes();
    if bytes.len() < 9 {
        return false;
    }
    let hash = &bytes[bytes.len() - 8..];
    hash.iter().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) && bytes[bytes.len() - 9] == b'.'
}

/// The file's mtime in milliseconds; pre-epoch mtimes sort as negative.
fn mtime_ms(stat: &std::fs::Metadata) -> Option<i128> {
    let modified = stat.modified().ok()?;
    Some(match modified.duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as i128,
        Err(error) => -(error.duration().as_millis() as i128),
    })
}

/// The report text for the resolved window, or `None` when no daemon logs exist.
///
/// # Errors
///
/// Returns [`IncidentUsageError`] when no window was passed and the options
/// do not resolve to one.
pub(crate) fn incident_report_text(
    options: &IncidentCommandOptions,
    window: Option<IncidentWindow>,
    now_ms: i64,
) -> Result<Option<String>, IncidentUsageError> {
    let IncidentWindow { since_ms, until_ms } = match window {
        Some(window) => window,
        None => resolve_incident_window(options, now_ms)?,
    };
    let log_source = read_incident_log_entries();
    if log_source.entries.is_empty() && log_source.scanned_count == 0 {
        return Ok(None);
    }
    let report = build_incident_report(
        &log_source.entries,
        &IncidentReportOptions {
            since_ms,
            until_ms,
            session: options.session.clone(),
            source: Some(log_source.source.clone()),
            scanned_count: Some(log_source.scanned_count),
            skipped_count: Some(log_source.skipped_count),
        },
    );
    Ok(Some(report.text))
}

/// Entry point for `prime-agent incident`; prints the timeline (or the
/// missing-logs message) to stdout. A passed-back window resolves relative
/// `HH:MM` bounds exactly once.
///
/// # Errors
///
/// Returns [`IncidentUsageError`] when the window must be resolved here and
/// does not resolve; the message is the operator-facing usage error.
pub(crate) fn run_incident(
    options: &IncidentCommandOptions,
    window: Option<IncidentWindow>,
) -> Result<(), IncidentUsageError> {
    let now_ms = crate::util_time::now_ms() as i64;
    match incident_report_text(options, window, now_ms)? {
        Some(text) => println!("{text}"),
        None => println!(
            "No daemon logs found under {}.",
            incident_logs_dir().display()
        ),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_separated_and_equals_attached_values() {
        let args: Vec<String> = ["--since", "20:02", "--until=21:00", "--session", "abc"]
            .iter()
            .map(std::string::ToString::to_string)
            .collect();
        assert_eq!(
            parse_incident_options(&args).expect("options"),
            IncidentCommandOptions {
                since: Some("20:02".to_string()),
                until: Some("21:00".to_string()),
                session: Some("abc".to_string()),
            }
        );
        assert_eq!(
            parse_incident_options(&[]).expect("options"),
            IncidentCommandOptions::default()
        );
    }

    #[test]
    fn rejects_unknown_missing_and_empty_values() {
        fn options(args: &[&str]) -> Result<IncidentCommandOptions, IncidentUsageError> {
            let args: Vec<String> = args.iter().map(std::string::ToString::to_string).collect();
            parse_incident_options(&args)
        }
        assert!(options(&["--json"]).is_err());
        assert!(options(&["extra"]).is_err());
        assert!(options(&["--since"]).is_err());
        assert!(options(&["--since", ""]).is_err());
        assert!(options(&["--since="]).is_err());
        assert!(options(&["--session", "  "]).is_err());
        assert_eq!(
            options(&["--json"]).unwrap_err().to_string(),
            "Unknown option for incident: --json"
        );
        assert_eq!(
            options(&["--since"]).unwrap_err().to_string(),
            "Option --since requires a value."
        );
    }

    #[test]
    fn resolves_the_default_window_and_rejects_unordered_bounds() {
        let now_ms = 1_789_597_800_000i64; // 2026-09-16T22:30:00Z
        let window = resolve_incident_window(&IncidentCommandOptions::default(), now_ms)
            .expect("the default window");
        assert_eq!(
            window,
            IncidentWindow {
                since_ms: now_ms - DEFAULT_WINDOW_MS,
                until_ms: now_ms,
            }
        );
        let unordered = IncidentCommandOptions {
            since: Some("2026-09-10T20:30".to_string()),
            until: Some("2026-09-10T20:00".to_string()),
            session: None,
        };
        assert_eq!(
            resolve_incident_window(&unordered, now_ms)
                .unwrap_err()
                .to_string(),
            "--until must be after --since."
        );
    }

    #[test]
    fn daemon_log_file_names_match_the_hash_suffix() {
        assert!(is_daemon_log_file_name("daemon.sock.98ed5cb2.log"));
        assert!(is_daemon_log_file_name("old-sock.a1b2c3d4.log"));
        // A custom socket basename without `.sock`.
        assert!(is_daemon_log_file_name("prime-daemon.a1b2c3d4.log"));
        assert!(!is_daemon_log_file_name("agent.jsonl"));
        assert!(!is_daemon_log_file_name("agent.jsonl.old"));
        assert!(!is_daemon_log_file_name("daemon.sock.log"));
        assert!(!is_daemon_log_file_name("daemon.sock.98ED5CB2.log"));
        // The TS pattern needs only `.` + 8 hex before `.log`, so a bare
        // hash-only name matches too.
        assert!(is_daemon_log_file_name(".98ed5cb2.log"));
    }
}

#[cfg(test)]
#[path = "source_tests.rs"]
mod source_tests;
