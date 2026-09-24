//! `prime-agent incident`, ported from TS `cli/incident.ts` (TS PR #2406):
//! reconstructs daemon-log forensics for a time window into an operator
//! timeline, so an incident no longer takes a human with grep through
//! hundreds of raw log lines. The classifier and report builder live in
//! `pa_tui::incident` (shared with the agents-view notice machinery); this
//! module owns the argument surface and the printing.

use pa_tui::incident::{
    build_incident_report, read_incident_log_entries, resolve_incident_window,
    IncidentCommandOptions, IncidentReportOptions,
};

use crate::config::{get_agent_dir, APP_NAME};

/// Parse `incident [--since <time>] [--until <time>] [--session <id>]`.
pub(crate) fn parse_incident_options(args: &[String]) -> Result<IncidentCommandOptions, String> {
    let mut options = IncidentCommandOptions::default();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        let (name, value) = match arg.find('=') {
            Some(equals_index) if arg.starts_with("--") => (
                arg[..equals_index].to_string(),
                Some(arg[equals_index + 1..].to_string()),
            ),
            _ => (arg.clone(), None),
        };
        match name.as_str() {
            "--since" | "--until" | "--session" => {}
            _ => return Err(format!("Unknown option for incident: {arg}")),
        }
        let mut value = match value {
            Some(value) => value,
            None => {
                index += 1;
                args.get(index)
                    .cloned()
                    .ok_or_else(|| format!("Option {name} requires a value."))?
            }
        };
        if value.trim().is_empty() {
            return Err(format!("Option {name} requires a value."));
        }
        match name.as_str() {
            "--since" => options.since = Some(value),
            "--until" => options.until = Some(value),
            _ => options.session = Some(std::mem::take(&mut value)),
        }
        index += 1;
    }
    Ok(options)
}

/// Run one `incident` invocation, returning the process exit code. Times
/// without a timezone are read as UTC, matching the timestamps the daemon
/// logs; the default window is the last 24 hours until now.
pub(crate) fn run_incident_command(args: &[String]) -> i32 {
    let logs_dir = get_agent_dir().join("logs");
    run_incident_command_at(args, crate::util_time::now_ms(), &logs_dir)
}

fn run_incident_command_at(args: &[String], now_ms: u64, logs_dir: &std::path::Path) -> i32 {
    let options = match parse_incident_options(args) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("Error: {message}");
            eprintln!("Run \"{APP_NAME} help incident\" for usage.");
            return 1;
        }
    };
    let window = match resolve_incident_window(&options, now_ms as i64) {
        Ok(window) => window,
        Err(message) => {
            eprintln!("Error: {message}");
            eprintln!("Run \"{APP_NAME} help incident\" for usage.");
            return 1;
        }
    };
    let source = read_incident_log_entries(logs_dir);
    if source.entries.is_empty() && source.scanned_count == 0 {
        println!("No daemon logs found under {}.", logs_dir.display());
        return 0;
    }
    let text = build_incident_report(
        &source.entries,
        &IncidentReportOptions {
            window,
            session: options.session.as_deref(),
            source: Some(&source),
        },
    );
    println!("{text}");
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(str::to_string).collect()
    }

    #[test]
    fn parses_value_flags_in_both_forms() {
        let options = parse_incident_options(&args(&[
            "--since",
            "2026-09-16T20:02",
            "--until=2026-09-16T20:21",
            "--session",
            "2339fb7da605",
        ]))
        .expect("options");
        assert_eq!(options.since.as_deref(), Some("2026-09-16T20:02"));
        assert_eq!(options.until.as_deref(), Some("2026-09-16T20:21"));
        assert_eq!(options.session.as_deref(), Some("2339fb7da605"));
    }

    #[test]
    fn rejects_unknown_options_and_missing_values() {
        assert_eq!(
            parse_incident_options(&args(&["--window", "1h"])).unwrap_err(),
            "Unknown option for incident: --window"
        );
        assert_eq!(
            parse_incident_options(&args(&["--since"])).unwrap_err(),
            "Option --since requires a value."
        );
        assert_eq!(
            parse_incident_options(&args(&["--since=", "--until", "now"])).unwrap_err(),
            "Option --since requires a value."
        );
    }

    #[test]
    fn prints_usage_errors_and_exits_one() {
        let missing = std::path::Path::new("/nonexistent-logs");
        assert_eq!(
            run_incident_command_at(&args(&["--since", "nonsense"]), 1_000, missing),
            1
        );
        assert_eq!(
            run_incident_command_at(
                &args(&["--since", "2026-09-16T20:02", "--until", "2026-09-16T20:02"]),
                1_000,
                missing
            ),
            1,
            "--until must be after --since"
        );
    }

    #[test]
    fn command_reads_the_logs_dir_and_exits_zero() {
        // The daemon-log fixture the report renders: one crash plus two
        // timeouts on the same worker inside the requested window.
        let dir = tempfile::TempDir::new().expect("temp dir");
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).expect("logs dir");
        let now = 1_788_000_000_000u64;
        let base = now - 60_000;
        let log = format!(
            "[{}] session worker 5b1d3aeb91ee registered (epoch 1, pid 4242)\n\
             [{}] session worker 5b1d3aeb91ee command attach timed out after 30000ms\n\
             [{}] session worker 5b1d3aeb91ee command attach timed out after 30000ms\n\
             [{}] session worker 5b1d3aeb91ee exited unexpectedly; restarting in 250ms (failure 1/5)\n",
            iso(base),
            iso(base + 1000),
            iso(base + 2000),
            iso(base + 3000),
        );
        std::fs::write(logs.join("prime-agent.sock.a1b2c3d4.log"), log).expect("log");

        // The window covers the fixture; the command exits zero after
        // printing the timeline.
        let exit = run_incident_command_at(
            &args(&[
                "--since",
                &iso(base - 60_000),
                "--until",
                &iso(base + 120_000),
            ]),
            now,
            &logs,
        );
        assert_eq!(exit, 0);

        // A window before the fixture still exits zero (an empty
        // timeline, not an error).
        let exit = run_incident_command_at(
            &args(&[
                "--since",
                &iso(base - 3_600_000),
                "--until",
                &iso(base - 1_800_000),
            ]),
            now,
            &logs,
        );
        assert_eq!(exit, 0);

        // A missing logs dir reports honestly, also exit zero.
        let exit = run_incident_command_at(&args(&[]), now, &dir.path().join("missing"));
        assert_eq!(exit, 0);
    }

    fn iso(ms: u64) -> String {
        pa_daemon::util::iso_from_unix_ms(ms)
    }
}
