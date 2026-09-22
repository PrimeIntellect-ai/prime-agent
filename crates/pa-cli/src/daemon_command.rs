//! The daemon-backed command runner behind the public commands `list`,
//! `stop`, `rename`, `send`, and `schedule`: argument parsing, request
//! shaping, and output rendering. Ported from `cli/daemon-command.ts`
//! (the `handleDaemonCommand` surface reachable from public routing).
//!
//! `schedule` maps to the internal `cron` command and `stop` to `kill`, exactly
//! like `runInternalAgentCommand`/`runNestedAgentCommand` in public-command.ts.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Result};
use pa_types::daemon::DaemonCommand;
use serde_json::{json, Value};

use crate::daemon_client::DaemonClient;
use crate::daemon_session_list::{
    format_session_list_table, get_session_summaries, live_session_summary,
    matches_session_id_suffix,
};

/// Parsed arguments for one daemon client command.
#[derive(Debug)]
struct ParsedDaemonCommand {
    socket_path: PathBuf,
    json: bool,
    positionals: Vec<String>,
    /// `--help`/`-h` becomes the internal no-op `help` command, exactly like
    /// the TS `runDaemonClientCommand` fallthrough. The public router
    /// intercepts help requests before this layer.
    help: bool,
}

/// Run one internal daemon command. Errors are printed by the public command
/// router exactly like the `handleDaemonCommand` catch in the TS CLI.
pub(crate) fn run_daemon_command(command: &str, args: &[String]) -> Result<()> {
    let parsed = parse_daemon_command(command, args)?;
    if parsed.help {
        return Ok(());
    }
    let mut client = DaemonClient::connect(&parsed.socket_path)?;
    match command {
        "list" => run_list(&mut client, &parsed.positionals, parsed.json),
        "kill" => run_kill(&mut client, &parsed.positionals, parsed.json),
        "rename" => run_rename(&mut client, &parsed.positionals, parsed.json),
        "send" => run_send(&mut client, &parsed.positionals, parsed.json),
        "cron" => run_cron(&mut client, &parsed.positionals, parsed.json),
        other => bail!("Unknown daemon command: {other}"),
    }
}

/// Port of `parseDaemonClientCommand`: option scanning with `--` passthrough
/// semantics (`send`/`cron` keep the separator as an operand, the others
/// consume it). The command name is fixed by the public router.
fn parse_daemon_command(command: &str, args: &[String]) -> Result<ParsedDaemonCommand> {
    let mut socket_path = default_socket_path();
    let mut json = false;
    let mut positionals: Vec<String> = Vec::new();
    let mut passthrough = false;
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        index += 1;
        if passthrough {
            positionals.push(arg.to_string());
            continue;
        }
        // send/cron parse `--` themselves as an end-of-flags separator.
        if arg == "--" {
            if command == "cron" || command == "send" {
                positionals.push(arg.to_string());
            }
            passthrough = true;
            continue;
        }
        // `--help`/`-h` before the command becomes the internal `help`
        // command, which prints nothing; the public router intercepts help
        // requests before this layer, so the branch only preserves parity.
        if arg == "--help" || arg == "-h" {
            return Ok(ParsedDaemonCommand {
                socket_path,
                json,
                positionals,
                help: true,
            });
        }
        if arg == "--socket" || arg == "--daemon-socket" {
            let value = args
                .get(index)
                .ok_or_else(|| anyhow!("{arg} requires a value"))?;
            index += 1;
            socket_path = normalize_socket_path(value);
            continue;
        }
        if arg == "--json" {
            json = true;
            continue;
        }
        positionals.push(arg.to_string());
    }
    Ok(ParsedDaemonCommand {
        socket_path,
        json,
        positionals,
        help: false,
    })
}

fn default_socket_path() -> PathBuf {
    pa_daemon::socket::default_daemon_socket_path()
}

/// `normalizeSocketPath`: lexically resolve against the current directory.
fn normalize_socket_path(value: &str) -> PathBuf {
    let path = Path::new(value);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

/// `requireSuccess`: surface the daemon's error text.
fn require_success(response: pa_types::daemon::DaemonResponse) -> Result<Option<Value>> {
    if !response.success {
        return Err(anyhow!(response.error.unwrap_or_default()));
    }
    Ok(response.data)
}

fn print_json(value: &Value) {
    match serde_json::to_string_pretty(value) {
        Ok(text) => println!("{text}"),
        Err(error) => eprintln!("Error: {error}"),
    }
}

/// `requireActiveSessionId`: the first operand.
fn require_active_session_id(args: &[String]) -> Result<String> {
    args.first()
        .cloned()
        .ok_or_else(|| anyhow!("Missing agent id or name"))
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

fn run_list(client: &mut DaemonClient, args: &[String], json: bool) -> Result<()> {
    let mut all = false;
    for arg in args {
        if arg == "-a" || arg == "--all" {
            all = true;
            continue;
        }
        bail!("Unknown list option: {arg}");
    }
    let response = client.request(list_command(all))?;
    let data = require_success(response)?.unwrap_or(Value::Null);
    if json {
        print_json(&data);
        return Ok(());
    }
    let Some(sessions) = get_session_summaries(&data) else {
        print_json(&data);
        return Ok(());
    };
    if sessions.is_empty() {
        println!(
            "{}",
            if all {
                "No agents."
            } else {
                "No active agents."
            }
        );
        return Ok(());
    }
    println!("{}", format_session_list_table(&sessions));
    Ok(())
}

fn list_command(all: bool) -> DaemonCommand {
    DaemonCommand::List {
        id: None,
        all: Some(all),
        cwd: None,
        session_dir: None,
        include_client_owned: None,
        rest: serde_json::Map::new(),
    }
}

/// `resolveLiveSessionSelector`: match a name/id/session-id selector against
/// the live session list, with unambiguous hex-suffix fallback.
fn resolve_live_session_selector(client: &mut DaemonClient, selector: &str) -> Result<String> {
    let response = client.request(list_command(false))?;
    let data = require_success(response)?;
    let sessions = data
        .as_ref()
        .and_then(|data| data.get("sessions"))
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("Daemon returned an invalid list response"))?;
    let mut exact: Vec<String> = Vec::new();
    let mut suffix: Vec<String> = Vec::new();
    for session in sessions {
        let Some(active_session_id) = session.get("activeSessionId").and_then(Value::as_str) else {
            continue;
        };
        let session_id = session.get("sessionId").and_then(Value::as_str);
        let session_name = session.get("sessionName").and_then(Value::as_str);
        if active_session_id == selector
            || session_id == Some(selector)
            || session_name == Some(selector)
        {
            exact.push(active_session_id.to_string());
            continue;
        }
        if matches_session_id_suffix(active_session_id, selector)
            || session_id.is_some_and(|id| matches_session_id_suffix(id, selector))
        {
            suffix.push(active_session_id.to_string());
        }
    }
    let matches = if exact.is_empty() { suffix } else { exact };
    match matches.len() {
        1 => Ok(matches[0].clone()),
        0 => Err(anyhow!("Unknown active session: {selector}")),
        _ => Err(anyhow!("Ambiguous active session \"{selector}\"")),
    }
}

// ---------------------------------------------------------------------------
// kill (stop)
// ---------------------------------------------------------------------------

fn run_kill(client: &mut DaemonClient, args: &[String], json: bool) -> Result<()> {
    let active_session_id = require_active_session_id(args)?;
    let response = client.request(DaemonCommand::Kill {
        id: None,
        active_session_id,
        rest: serde_json::Map::new(),
    })?;
    print_response_data(response, json)
}

/// `printResponseData`: pretty-print the response data (the whole response as
/// JSON when there is none and `--json` was asked), else `ok`.
fn print_response_data(response: pa_types::daemon::DaemonResponse, json: bool) -> Result<()> {
    let data = require_success(response.clone())?;
    if json || data.is_some() {
        let value = data.unwrap_or_else(|| response_value(&response));
        print_json(&value);
        return Ok(());
    }
    println!("ok");
    Ok(())
}

/// The response as the TS wire shape (`data ?? response` prints the frame the
/// daemon sent, including the `type` tag the typed struct does not carry).
fn response_value(response: &pa_types::daemon::DaemonResponse) -> Value {
    let mut value = json!({
        "type": "response",
        "command": response.command,
        "success": response.success,
    });
    let object = value.as_object_mut().expect("response object");
    if let Some(id) = &response.id {
        object.insert("id".to_string(), json!(id));
    }
    if let Some(data) = &response.data {
        object.insert("data".to_string(), data.clone());
    }
    if let Some(error) = &response.error {
        object.insert("error".to_string(), json!(error));
    }
    value
}

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

fn run_rename(client: &mut DaemonClient, args: &[String], json: bool) -> Result<()> {
    let active_session_id = require_active_session_id(args)?;
    let name = args[1..].join(" ").trim().to_string();
    if name.is_empty() {
        bail!("Usage: prime-agent rename <agent> <name>");
    }
    let response = client.request(DaemonCommand::Rename {
        id: None,
        active_session_id,
        name: name.clone(),
        rest: serde_json::Map::new(),
    })?;
    let data = require_success(response)?.unwrap_or(Value::Null);
    if json {
        print_json(&data);
        return Ok(());
    }
    match live_session_summary(&data) {
        Some(summary) => {
            let summary_name = summary.get("sessionName").and_then(Value::as_str);
            println!(
                "Renamed {} to {}",
                summary
                    .get("activeSessionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                summary_name.unwrap_or(&name)
            );
        }
        None => print_json(&data),
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

struct ParsedSendArgs {
    target_active_session_id: String,
    from_active_session_id: Option<String>,
    message: String,
}

fn run_send(client: &mut DaemonClient, args: &[String], json: bool) -> Result<()> {
    let parsed = parse_send_args(args)?;
    let response = client.request(DaemonCommand::SendMessage {
        id: None,
        target_active_session_id: parsed.target_active_session_id,
        message: parsed.message,
        from_active_session_id: parsed.from_active_session_id,
        agent_origin: None,
        delivery_mode: None,
        rest: serde_json::Map::new(),
    })?;
    let data = require_success(response)?.unwrap_or(Value::Null);
    if json {
        print_json(&data);
        return Ok(());
    }
    // `isAgentMessageReceipt`: a target block with a routable active id.
    let receipt_target = data
        .get("target")
        .filter(|target| {
            target
                .get("activeSessionId")
                .and_then(Value::as_str)
                .is_some()
        })
        .and_then(|target| {
            target
                .get("sessionName")
                .and_then(Value::as_str)
                .or_else(|| target.get("activeSessionId").and_then(Value::as_str))
        })
        .map(str::to_string);
    let Some(target) = receipt_target else {
        println!("ok");
        return Ok(());
    };
    let queued = data.get("deliveryStatus").and_then(Value::as_str) == Some("queued");
    println!(
        "{}",
        if queued {
            format!("Queued for {target}")
        } else {
            format!("Sent to {target}")
        }
    );
    Ok(())
}

fn parse_send_args(args: &[String]) -> Result<ParsedSendArgs> {
    let mut from_active_session_id: Option<String> = None;
    let mut target_active_session_id: Option<String> = None;
    let mut explicit_message: Option<String> = None;
    let mut message_parts: Vec<String> = Vec::new();
    let mut parse_options = true;
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        index += 1;
        if parse_options && arg == "--" {
            parse_options = false;
            continue;
        }
        if parse_options && arg == "--from" {
            let value = args
                .get(index)
                .ok_or_else(|| anyhow!("--from requires a session id or name"))?;
            index += 1;
            from_active_session_id = Some(value.clone());
            continue;
        }
        if parse_options && arg == "--message" {
            if target_active_session_id.is_none() {
                bail!("--message must appear after the target session");
            }
            let value = args
                .get(index)
                .ok_or_else(|| anyhow!("--message requires message text"))?;
            index += 1;
            explicit_message = Some(value.clone());
            parse_options = false;
            continue;
        }
        if parse_options && arg.starts_with("--") {
            bail!("Unknown option for send: {arg} (use -- before message text starting with --)");
        }
        if target_active_session_id.is_none() {
            target_active_session_id = Some(arg.to_string());
            continue;
        }
        message_parts.push(arg.to_string());
    }
    if explicit_message.is_some() && !message_parts.is_empty() {
        bail!("Usage: prime-agent send [--from <agent>] <agent> [--message <message>|<message>]");
    }
    let message = explicit_message
        .unwrap_or_else(|| message_parts.join(" "))
        .trim()
        .to_string();
    if target_active_session_id.is_none() || message.is_empty() {
        bail!("Usage: prime-agent send [--from <agent>] <agent> [--message <message>|<message>]");
    }
    Ok(ParsedSendArgs {
        target_active_session_id: target_active_session_id.expect("checked above"),
        from_active_session_id,
        message,
    })
}

// ---------------------------------------------------------------------------
// cron (schedule)
// ---------------------------------------------------------------------------

fn run_cron(client: &mut DaemonClient, args: &[String], json: bool) -> Result<()> {
    let subcommand = args.first().map(String::as_str).unwrap_or("list");
    match subcommand {
        "list" => run_cron_list(client, args, json),
        "add" | "schedule" => run_cron_add(client, args, json),
        "cancel" | "delete" | "remove" => run_cron_cancel(client, args, json),
        other => bail!("Unknown schedule command: {other}"),
    }
}

fn run_cron_list(client: &mut DaemonClient, args: &[String], json: bool) -> Result<()> {
    let include_inactive = args.iter().skip(1).any(|arg| arg == "--all" || arg == "-a");
    let selector = args
        .iter()
        .skip(1)
        .find(|arg| !arg.starts_with('-') && arg.as_str() != "list");
    let active_session_id = match selector {
        Some(selector) => Some(resolve_live_session_selector(client, selector)?),
        None => None,
    };
    let response = client.request(DaemonCommand::CronList {
        id: None,
        active_session_id,
        include_inactive: Some(include_inactive),
        rest: serde_json::Map::new(),
    })?;
    let data = require_success(response)?.unwrap_or(Value::Null);
    if json {
        print_json(&data);
        return Ok(());
    }
    let Some(jobs) = data.get("jobs").and_then(Value::as_array) else {
        print_json(&data);
        return Ok(());
    };
    if jobs.is_empty() {
        println!("No scheduled prompts.");
        return Ok(());
    }
    for job in jobs {
        println!("{}", format_agent_cron_job(job));
    }
    Ok(())
}

fn run_cron_add(client: &mut DaemonClient, args: &[String], json: bool) -> Result<()> {
    let usage = "Usage: prime-agent schedule add <agent> <schedule> -- <message>";
    let separator = args
        .iter()
        .position(|arg| arg == "--")
        .ok_or_else(|| anyhow!("{usage}"))?;
    let Some(active_session_id) = args.get(1) else {
        bail!("{usage}");
    };
    if separator < 2 {
        bail!("{usage}");
    }
    let schedule = args[2..separator].join(" ").trim().to_string();
    let message = args[separator + 1..].join(" ").trim().to_string();
    if schedule.is_empty() || message.is_empty() {
        bail!("{usage}");
    }
    let response = client.request(DaemonCommand::CronAdd {
        id: None,
        active_session_id: active_session_id.clone(),
        schedule,
        prompt: message,
        promote_owned_session: None,
        rest: serde_json::Map::new(),
    })?;
    let data = require_success(response)?.unwrap_or(Value::Null);
    if json {
        print_json(&data);
        return Ok(());
    }
    match cron_job_id_and_next_run(&data) {
        Some((id, next_run)) => println!("Scheduled {id} next={next_run}"),
        None => println!("Scheduled prompt."),
    }
    Ok(())
}

fn run_cron_cancel(client: &mut DaemonClient, args: &[String], json: bool) -> Result<()> {
    let Some(job_id) = args.get(1) else {
        bail!("Usage: prime-agent schedule cancel <job-id>");
    };
    let response = client.request(DaemonCommand::CronCancel {
        id: None,
        active_session_id: None,
        job_id: job_id.clone(),
        rest: serde_json::Map::new(),
    })?;
    let data = require_success(response)?.unwrap_or(Value::Null);
    if json {
        print_json(&data);
        return Ok(());
    }
    match cron_job_id_and_next_run(&data) {
        Some((id, _)) => println!("Cancelled {id}"),
        None => println!("Cancelled cron job."),
    }
    Ok(())
}

/// `getCronJob`: the job id and next run when the response carries a job.
fn cron_job_id_and_next_run(data: &Value) -> Option<(String, String)> {
    let job = data.get("job")?;
    let id = job.get("id").and_then(Value::as_str)?.to_string();
    let next_run = job
        .get("nextRunAt")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| "-".to_string());
    Some((id, next_run))
}

/// `formatAgentCronJob`: the one-line schedule list entry.
fn format_agent_cron_job(job: &Value) -> String {
    let id = job.get("id").and_then(Value::as_str).unwrap_or_default();
    let status = job
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let label = job
        .get("label")
        .and_then(Value::as_str)
        .map(|label| format!(" label=\"{label}\""))
        .unwrap_or_default();
    let next = cron_datetime(job.get("nextRunAt"));
    let last = cron_datetime(job.get("lastRunAt"));
    let skipped = job
        .get("lastSkippedAt")
        .map(|value| format!(" skipped={}", cron_datetime(Some(value))))
        .unwrap_or_default();
    let run_count = job
        .get("runCount")
        .and_then(Value::as_f64)
        .unwrap_or_default();
    let expression = job
        .get("schedule")
        .and_then(|schedule| schedule.get("expression"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let prompt: String = job
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let preview: String = prompt.chars().take(80).collect();
    let error = job
        .get("lastError")
        .and_then(Value::as_str)
        .map(|error| format!(" error={error}"))
        .unwrap_or_default();
    format!(
        "{id} {status}{label} next={next} last={last}{skipped} runs={run_count} schedule=\"{expression}\" prompt=\"{preview}\"{error}"
    )
}

/// `toLocaleString()` for a cron timestamp: en-US long-form-ish date with a
/// 12-hour clock, e.g. `9/16/2026, 6:36:59 PM`. Rendered in UTC; a daemon
/// machine running a non-UTC system timezone shifts the wall-clock part.
fn cron_datetime(value: Option<&Value>) -> String {
    let Some(value) = value.and_then(Value::as_str) else {
        return "-".to_string();
    };
    let Some(ms) = crate::daemon_session_list::parse_iso_ms(value) else {
        return "-".to_string();
    };
    let seconds_of_day = (ms / 1000) % 86_400;
    let hour24 = seconds_of_day / 3600;
    let minute = (seconds_of_day % 3600) / 60;
    let second = seconds_of_day % 60;
    let (hour12, meridiem) = match hour24 % 12 {
        0 => (12, if hour24 < 12 { "AM" } else { "PM" }),
        other => (other, if hour24 < 12 { "AM" } else { "PM" }),
    };
    let days = (ms / 1000) / 86_400;
    let (year, month, day) = civil_from_days(days);
    format!("{month}/{day}/{year}, {hour12}:{minute:02}:{second:02} {meridiem}")
}

/// Civil date from days since the epoch (Howard Hinnant's algorithm).
fn civil_from_days(days: u64) -> (i64, u32, u32) {
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { y + 1 } else { y }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parse_consumes_socket_json_and_separator() {
        let parsed =
            parse_daemon_command("list", &args(&["--json", "--socket", "/s", "-a"])).unwrap();
        assert_eq!(parsed.socket_path, PathBuf::from("/s"));
        assert!(parsed.json);
        assert_eq!(parsed.positionals, args(&["-a"]));

        let missing = parse_daemon_command("list", &args(&["--daemon-socket"])).unwrap_err();
        assert_eq!(missing.to_string(), "--daemon-socket requires a value");
    }

    #[test]
    fn separator_passes_through_only_for_send_and_cron() {
        let send = parse_daemon_command("send", &args(&["target", "--", "hi", "there"])).unwrap();
        assert_eq!(send.positionals, args(&["target", "--", "hi", "there"]));
        let list = parse_daemon_command("list", &args(&["--", "-a"])).unwrap();
        assert_eq!(list.positionals, args(&["-a"]));
    }

    #[test]
    fn send_args_match_ts_usage_rules() {
        let parsed = parse_send_args(&args(&["--from", "me", "target", "hello", "there"])).unwrap();
        assert_eq!(parsed.target_active_session_id, "target");
        assert_eq!(parsed.from_active_session_id.as_deref(), Some("me"));
        assert_eq!(parsed.message, "hello there");

        let flag = parse_send_args(&args(&["target", "--message", "queued"])).unwrap();
        assert_eq!(flag.message, "queued");

        let explicit_and_positional =
            parse_send_args(&args(&["target", "--message", "queued", "extra"]));
        assert!(explicit_and_positional.is_err());

        let unknown = parse_send_args(&args(&["target", "--bogus"]));
        assert!(unknown.is_err());

        let no_target = parse_send_args(&args(&["--message", "text"]));
        assert!(no_target.is_err());
    }

    #[test]
    fn cron_job_line_matches_captured_ts_golden() {
        let job = json!({
            "id": "0451e5a9-951c-457b-ae76-ea3142ea5d25",
            "status": "active",
            "nextRunAt": "2026-09-16T18:36:59.287Z",
            "runCount": 0,
            "schedule": { "expression": "every 5 minutes" },
            "prompt": "do   the thing",
        });
        assert_eq!(
            format_agent_cron_job(&job),
            "0451e5a9-951c-457b-ae76-ea3142ea5d25 active next=9/16/2026, 6:36:59 PM last=- runs=0 schedule=\"every 5 minutes\" prompt=\"do the thing\""
        );
    }
}
