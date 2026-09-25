//! Cron scheduling core: schedule parsing (`in`/`every`/`at`/cron),
//! five-field cron expression evaluation, and `/heartbeat` command parsing.
//! Port of the pure-function half of core/cron-jobs.ts; the file-backed job
//! store lives in the `store` submodule.

pub mod scheduler;
pub mod store;

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

pub const DEFAULT_HEARTBEAT_SCHEDULE: &str = "every 5m";
pub const DEFAULT_HEARTBEAT_DELIVERY_MODE: DeliveryMode = DeliveryMode::Steer;
const ONE_SECOND_MS: u64 = 1000;
const ONE_MINUTE_MS: u64 = 60 * ONE_SECOND_MS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Active,
    Paused,
    Completed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleKind {
    Once,
    Cron,
    Interval,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryMode {
    Steer,
    FollowUp,
}

/// A parsed schedule expression.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCronSchedule {
    pub kind: ScheduleKind,
    pub expression: String,
    /// Only for `interval` schedules.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_ms: Option<u64>,
}

/// One scheduled job (persisted wire shape). Session identity fields are
/// required (the TS guard rejects records without them).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCronJob {
    pub id: String,
    pub status: JobStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_kind: Option<String>,
    /// Delivery mode for heartbeat jobs when the session is busy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_mode: Option<DeliveryMode>,
    pub active_session_id: String,
    pub session_id: String,
    pub session_file: String,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub prompt: String,
    pub schedule: AgentCronSchedule,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(rename = "nextRunAt", default, skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<String>,
    #[serde(rename = "lastRunAt", default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
    #[serde(
        rename = "lastSkippedAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub last_skipped_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(rename = "runCount", default)]
    pub run_count: u64,
}

/// Parsed `/heartbeat` command.
#[derive(Debug, Clone, PartialEq)]
pub enum ParsedHeartbeatCommand {
    Status,
    Pause,
    Resume,
    Clear,
    Set {
        schedule: String,
        instruction: String,
        delivery_mode: Option<DeliveryMode>,
    },
}

/// Session activity snapshot used by heartbeat deferral.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HeartbeatSessionActivity {
    pub is_streaming: bool,
    pub is_compacting: bool,
    pub is_retrying: bool,
    pub is_bash_running: bool,
    pub has_pending_session_work: bool,
    pub unfinished_action_count: usize,
}

/// Parse a schedule expression into a schedule plus its first run time.
/// `now_millis` is the epoch time in milliseconds.
pub fn parse_agent_cron_schedule(
    input: &str,
    now_millis: u64,
) -> anyhow::Result<(AgentCronSchedule, u64)> {
    let text: String = strip_matching_quotes(input.trim()).to_string();
    if text.is_empty() {
        anyhow::bail!("Cron schedule cannot be empty");
    }
    // `in <n> <unit>`: one-shot.
    let lower = text.to_lowercase();
    if let Some(rest) = lower.strip_prefix("in ") {
        if let Some(next) = parse_in_delay(rest, now_millis)? {
            return Ok((
                AgentCronSchedule {
                    kind: ScheduleKind::Once,
                    expression: text,
                    interval_ms: None,
                },
                next,
            ));
        }
    }
    // `every|each <n> <unit>`: recurring interval.
    for prefix in ["every ", "each "] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            if let Some(next) = parse_every_delay(rest, now_millis)? {
                let interval_ms = next - now_millis;
                return Ok((
                    AgentCronSchedule {
                        kind: ScheduleKind::Interval,
                        expression: text,
                        interval_ms: Some(interval_ms),
                    },
                    next,
                ));
            }
        }
    }
    // `at <ISO date>`: one-shot.
    if lower.starts_with("at ") {
        let when = parse_iso_millis(text[3..].trim())
            .ok_or_else(|| anyhow::anyhow!("Invalid one-shot schedule. Use: at <ISO date>"))?;
        if when <= now_millis {
            anyhow::bail!("One-shot schedule must be in the future");
        }
        return Ok((
            AgentCronSchedule {
                kind: ScheduleKind::Once,
                expression: text,
                interval_ms: None,
            },
            when,
        ));
    }
    let expression = normalize_cron_alias(&text);
    let next_run_at = next_cron_run_after(&expression, now_millis)?;
    Ok((
        AgentCronSchedule {
            kind: ScheduleKind::Cron,
            expression,
            interval_ms: None,
        },
        next_run_at,
    ))
}

fn unit_multiplier(unit: &str, allow_seconds: bool) -> Option<u64> {
    let unit = unit.trim();
    let seconds = allow_seconds && matches!(unit, "s" | "sec" | "secs" | "second" | "seconds");
    if seconds {
        return Some(ONE_SECOND_MS);
    }
    if matches!(unit, "m" | "min" | "mins" | "minute" | "minutes") {
        return Some(ONE_MINUTE_MS);
    }
    if matches!(unit, "h" | "hr" | "hrs" | "hour" | "hours") {
        return Some(60 * ONE_MINUTE_MS);
    }
    if matches!(unit, "d" | "day" | "days") {
        return Some(24 * 60 * ONE_MINUTE_MS);
    }
    None
}

fn parse_in_delay(rest: &str, now_millis: u64) -> anyhow::Result<Option<u64>> {
    let Some((amount, unit)) = split_amount_unit(rest) else {
        return Ok(None);
    };
    let Some(multiplier) = unit_multiplier(unit, false) else {
        return Ok(None);
    };
    Ok(Some(now_millis + amount.saturating_mul(multiplier)))
}

/// `<digits> <unit?>` with the unit optionally attached (`10m`, `10 m`).
fn split_amount_unit(rest: &str) -> Option<(u64, &str)> {
    let rest = rest.trim();
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    let digits_len = digits.len();
    let unit = rest[digits_len..].trim();
    let amount: u64 = digits.parse().ok()?;
    if !unit.is_empty()
        && !rest[digits_len..].starts_with(char::is_whitespace)
        && !unit.chars().all(|c| c.is_ascii_alphabetic())
    {
        return None;
    }
    Some((amount, unit))
}

fn parse_every_delay(rest: &str, now_millis: u64) -> anyhow::Result<Option<u64>> {
    let Some((amount, unit)) = split_amount_unit(rest) else {
        return Ok(None);
    };
    let Some(multiplier) = unit_multiplier(unit, true) else {
        return Ok(None);
    };
    let interval_ms = amount.saturating_mul(multiplier);
    if interval_ms < 10 * ONE_SECOND_MS {
        anyhow::bail!("Recurring interval must be at least 10 seconds");
    }
    Ok(Some(now_millis + interval_ms))
}

pub fn normalize_heartbeat_schedule(input: Option<&str>) -> String {
    let text = input.map(str::trim).filter(|text| !text.is_empty());
    let Some(text) = text else {
        return DEFAULT_HEARTBEAT_SCHEDULE.to_string();
    };
    if let Some((_, unit)) = split_amount_unit(text) {
        if !unit.is_empty() && unit_multiplier(unit, true).is_some() {
            return format!("every {text}");
        }
    }
    text.to_string()
}

pub fn normalize_heartbeat_delivery_mode(
    value: Option<&str>,
) -> anyhow::Result<Option<DeliveryMode>> {
    match value {
        None => Ok(None),
        Some("steer") => Ok(Some(DeliveryMode::Steer)),
        Some("follow_up") => Ok(Some(DeliveryMode::FollowUp)),
        Some(_) => Err(anyhow::anyhow!(
            "Heartbeat delivery mode must be \"steer\" or \"follow_up\""
        )),
    }
}

pub fn resolve_heartbeat_streaming_behavior(delivery_mode: Option<DeliveryMode>) -> &'static str {
    match delivery_mode.unwrap_or(DEFAULT_HEARTBEAT_DELIVERY_MODE) {
        DeliveryMode::FollowUp => "followUp",
        DeliveryMode::Steer => "steer",
    }
}

/// Parse a `/heartbeat ...` command body.
pub fn parse_heartbeat_command(input: &str) -> anyhow::Result<ParsedHeartbeatCommand> {
    let text = input
        .strip_prefix("/heartbeat")
        .filter(|rest| rest.chars().next().is_none_or(char::is_whitespace))
        .map_or_else(|| input.trim(), str::trim_start);
    if text.is_empty() || text == "status" {
        return Ok(ParsedHeartbeatCommand::Status);
    }
    if text == "pause" {
        return Ok(ParsedHeartbeatCommand::Pause);
    }
    if text == "resume" {
        return Ok(ParsedHeartbeatCommand::Resume);
    }
    if text == "clear" || text == "stop" {
        return Ok(ParsedHeartbeatCommand::Clear);
    }
    let leading = consume_delivery_option(text)?;
    let mut delivery_mode = leading.0;
    let rest = leading.1;

    if let Some(option) = consume_every_option(&rest)? {
        let trailing = consume_delivery_option(&option.1)?;
        delivery_mode = trailing.0.or(delivery_mode);
        if trailing.1.is_empty() {
            anyhow::bail!(
                "Usage: /heartbeat [--every <interval>] [--steer|--follow-up] <instruction>"
            );
        }
        return Ok(ParsedHeartbeatCommand::Set {
            schedule: normalize_heartbeat_schedule(Some(&option.0)),
            instruction: trailing.1,
            delivery_mode,
        });
    }
    if let Some(leading_schedule) = consume_leading_every_schedule(&rest) {
        let trailing = consume_delivery_option(&leading_schedule.1)?;
        delivery_mode = trailing.0.or(delivery_mode);
        if trailing.1.is_empty() {
            anyhow::bail!(
                "Usage: /heartbeat [--every <interval>] [--steer|--follow-up] <instruction>"
            );
        }
        return Ok(ParsedHeartbeatCommand::Set {
            schedule: normalize_heartbeat_schedule(Some(&leading_schedule.0)),
            instruction: trailing.1,
            delivery_mode,
        });
    }
    let rest = rest.trim();
    if rest.is_empty() {
        anyhow::bail!("Usage: /heartbeat [--every <interval>] [--steer|--follow-up] <instruction>");
    }
    Ok(ParsedHeartbeatCommand::Set {
        schedule: DEFAULT_HEARTBEAT_SCHEDULE.to_string(),
        instruction: rest.to_string(),
        delivery_mode,
    })
}

fn consume_delivery_option(text: &str) -> anyhow::Result<(Option<DeliveryMode>, String)> {
    let mut rest = text.trim().to_string();
    let lower = rest.to_lowercase();
    if lower == "--deliver" || lower.ends_with(" --deliver") {
        return Err(anyhow::anyhow!(
            "Heartbeat delivery mode must be \"steer\" or \"follow_up\""
        ));
    }
    let mut delivery_mode: Option<DeliveryMode> = None;
    while let Some((mode, remaining)) = consume_leading_delivery_flag(&rest)? {
        delivery_mode = Some(mode);
        rest = remaining.trim().to_string();
    }
    let mut trailing_delivery_mode: Option<DeliveryMode> = None;
    while let Some((mode, remaining)) = consume_trailing_delivery_flag(&rest)? {
        // Consume all trailing flags but keep the rightmost (textually latest).
        trailing_delivery_mode = trailing_delivery_mode.or(Some(mode));
        rest = remaining.trim().to_string();
    }
    Ok((trailing_delivery_mode.or(delivery_mode), rest))
}

fn consume_leading_delivery_flag(text: &str) -> anyhow::Result<Option<(DeliveryMode, String)>> {
    let trimmed = text.trim_start();
    let Some(after_dash) = trimmed.strip_prefix("--") else {
        return Ok(None);
    };
    if let Some(value) = after_dash.strip_prefix("deliver") {
        let value = value
            .strip_prefix('=')
            .map(String::from)
            .or_else(|| value.strip_prefix(char::is_whitespace).map(String::from))
            .unwrap_or_default();
        if value.is_empty() {
            anyhow::bail!("Heartbeat delivery mode must be \"steer\" or \"follow_up\"");
        }
        let (token, remainder) = split_first_token(&value);
        let mode = parse_delivery_mode_token(token)?;
        return Ok(Some((mode, remainder.to_string())));
    }
    for (token, mode) in [
        ("steer", DeliveryMode::Steer),
        ("follow-up", DeliveryMode::FollowUp),
        ("follow_up", DeliveryMode::FollowUp),
    ] {
        if let Some(rest) = after_dash.strip_prefix(token) {
            check_standalone(after_dash, token)?;
            return Ok(Some((mode, rest.to_string())));
        }
    }
    Ok(None)
}

fn check_standalone(rest: &str, token: &str) -> anyhow::Result<()> {
    let after = &rest[token.len()..];
    if !after.is_empty() && !after.starts_with(char::is_whitespace) {
        anyhow::bail!("Heartbeat delivery mode must be \"steer\" or \"follow_up\"");
    }
    Ok(())
}

fn split_first_token(value: &str) -> (&str, &str) {
    match value.find(char::is_whitespace) {
        Some(index) => (&value[..index], value[index..].trim_start()),
        None => (value, ""),
    }
}

fn consume_trailing_delivery_flag(text: &str) -> anyhow::Result<Option<(DeliveryMode, String)>> {
    let lower = text.to_lowercase();
    if let Some(index) = lower.rfind(" --deliver ") {
        let token = text[index + " --deliver ".len()..].trim();
        if !token.is_empty() && !token.contains(char::is_whitespace) {
            return Ok(Some((
                parse_delivery_mode_token(token)?,
                text[..index].to_string(),
            )));
        }
    }
    if let Some(index) = lower.rfind(" --deliver=") {
        let token = text[index + " --deliver=".len()..].trim();
        if !token.is_empty() && !token.contains(char::is_whitespace) {
            return Ok(Some((
                parse_delivery_mode_token(token)?,
                text[..index].to_string(),
            )));
        }
    }
    for token in ["--follow-up", "--follow_up", "--steer"] {
        if let Some(index) = lower.rfind(&format!(" {token}")) {
            if index + token.len() + 1 == text.len() {
                return Ok(Some((
                    parse_delivery_mode_token(&token[2..])?,
                    text[..index].to_string(),
                )));
            }
        }
    }
    Ok(None)
}

fn parse_delivery_mode_token(token: &str) -> anyhow::Result<DeliveryMode> {
    let normalized = token.to_lowercase().replace('-', "_");
    match normalized.as_str() {
        "steer" => Ok(DeliveryMode::Steer),
        "follow_up" => Ok(DeliveryMode::FollowUp),
        _ => Err(anyhow::anyhow!(
            "Heartbeat delivery mode must be \"steer\" or \"follow_up\""
        )),
    }
}

fn consume_every_option(text: &str) -> anyhow::Result<Option<(String, String)>> {
    let trimmed = text.trim_start();
    let Some(rest) = trimmed.strip_prefix("--every") else {
        return Ok(None);
    };
    let rest = match rest.strip_prefix('=') {
        Some(value) => value.to_string(),
        None => match rest.strip_prefix(char::is_whitespace) {
            Some(value) => value.to_string(),
            // No separator: "--everyfoo" is not an every option.
            None if !rest.is_empty() => return Ok(None),
            None => String::new(),
        },
    };
    // Quoted or bare interval value.
    let (interval, remainder): (String, String) = if let Some(stripped) = rest.strip_prefix('"') {
        match stripped.find('"') {
            Some(index) => (
                stripped[..index].to_string(),
                stripped[index + 1..].to_string(),
            ),
            None => (stripped.to_string(), String::new()),
        }
    } else if let Some(stripped) = rest.strip_prefix('\'') {
        match stripped.find('\'') {
            Some(index) => (
                stripped[..index].to_string(),
                stripped[index + 1..].to_string(),
            ),
            None => (stripped.to_string(), String::new()),
        }
    } else {
        let (token, rest) = split_first_token(&rest);
        (token.to_string(), rest.to_string())
    };
    if interval.is_empty() {
        anyhow::bail!("Usage: /heartbeat [--every <interval>] [--steer|--follow-up] <instruction>");
    }
    Ok(Some((interval, remainder.trim_start().to_string())))
}

fn consume_leading_every_schedule(text: &str) -> Option<(String, String)> {
    let lower = text.to_lowercase();
    for prefix in ["every ", "each "] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            let first_token = rest.split_whitespace().next()?;
            let Some((_, unit)) = split_amount_unit(first_token) else {
                continue;
            };
            if unit.is_empty() || unit_multiplier(unit, true).is_none() {
                continue;
            }
            {
                let consumed = prefix.len() + first_token.len();
                let consumed = consumed.min(text.len());
                let remainder = text[consumed..].trim();
                // Strip a standalone "--" separator, never a flag.
                let remainder = remainder
                    .strip_prefix("--")
                    .filter(|after| after.is_empty() || after.starts_with(char::is_whitespace))
                    .map_or(remainder, str::trim)
                    .trim()
                    .to_string();
                let interval = format!("{} {}", prefix.trim(), first_token);
                return Some((interval, remainder));
            }
        }
    }
    None
}

pub fn is_heartbeat_cron_job(job: &AgentCronJob) -> bool {
    matches!(job.source.as_deref(), Some("heartbeat" | "rlm_heartbeat"))
}

/// Whether a due heartbeat should wait instead of firing now.
pub fn should_defer_heartbeat_cron_job(
    job: &AgentCronJob,
    activity: &HeartbeatSessionActivity,
) -> bool {
    if !is_heartbeat_cron_job(job) {
        return false;
    }
    let busy_besides_streaming = activity.is_compacting
        || activity.is_retrying
        || activity.is_bash_running
        || activity.has_pending_session_work
        || (!activity.is_streaming && activity.unfinished_action_count > 0);
    if busy_besides_streaming {
        return true;
    }
    if resolve_heartbeat_streaming_behavior(job.delivery_mode) == "steer" {
        return false;
    }
    activity.is_streaming
}

/// Next run time for a schedule after `after_millis`.
pub fn next_run_at_for_schedule(
    schedule: &AgentCronSchedule,
    after_millis: u64,
) -> anyhow::Result<Option<u64>> {
    match schedule.kind {
        ScheduleKind::Once => Ok(None),
        ScheduleKind::Interval => {
            let Some(interval_ms) = schedule.interval_ms else {
                anyhow::bail!("Invalid interval schedule: {}", schedule.expression);
            };
            if interval_ms == 0 {
                anyhow::bail!("Invalid interval schedule: {}", schedule.expression);
            }
            Ok(Some(after_millis + interval_ms))
        }
        ScheduleKind::Cron => next_cron_run_after(&schedule.expression, after_millis).map(Some),
    }
}

/// One-line job summary (the TS format; timestamps in local rendering are
/// approximated by UTC ISO strings).
pub fn format_agent_cron_job(job: &AgentCronJob) -> String {
    let next = job.next_run_at.as_deref().unwrap_or("-");
    let last = job.last_run_at.as_deref().unwrap_or("-");
    let preview: String = job.prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    let preview: String = preview.chars().take(80).collect();
    let error = job
        .last_error
        .as_ref()
        .map(|error| format!(" error={error}"))
        .unwrap_or_default();
    let label = job
        .label
        .as_ref()
        .map(|label| format!(" label=\"{label}\""))
        .unwrap_or_default();
    let skipped = job
        .last_skipped_at
        .as_ref()
        .map(|skipped| format!(" skipped={skipped}"))
        .unwrap_or_default();
    let status = match job.status {
        JobStatus::Active => "active",
        JobStatus::Paused => "paused",
        JobStatus::Completed => "completed",
        JobStatus::Cancelled => "cancelled",
    };
    format!(
        "{} {status}{} next={next} last={last}{skipped} runs={} schedule=\"{}\" prompt=\"{preview}\"{error}",
        job.id, label, job.run_count, job.schedule.expression
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct CronFields {
    minute: BTreeSet<u32>,
    hour: BTreeSet<u32>,
    day_of_month: BTreeSet<u32>,
    month: BTreeSet<u32>,
    day_of_week: BTreeSet<u32>,
}

fn next_cron_run_after(expression: &str, after_millis: u64) -> anyhow::Result<u64> {
    let fields = parse_cron_expression(expression)?;
    // Start at the next whole minute.
    let mut candidate = (after_millis / ONE_MINUTE_MS + 1) * ONE_MINUTE_MS;
    let deadline = candidate + 366 * 24 * 60 * ONE_MINUTE_MS;
    while candidate <= deadline {
        if matches_cron_fields(candidate, &fields) {
            return Ok(candidate);
        }
        candidate += ONE_MINUTE_MS;
    }
    anyhow::bail!("Cron schedule did not match within one year: {expression}")
}

fn parse_cron_expression(expression: &str) -> anyhow::Result<CronFields> {
    let parts: Vec<&str> = expression.split_whitespace().collect();
    if parts.len() != 5 {
        anyhow::bail!(
            "Unsupported cron schedule. Use 'in 10m', 'at <ISO date>', @hourly, or five fields: minute hour day month weekday"
        );
    }
    Ok(CronFields {
        minute: parse_cron_field(parts[0], 0, 59)?,
        hour: parse_cron_field(parts[1], 0, 23)?,
        day_of_month: parse_cron_field(parts[2], 1, 31)?,
        month: parse_cron_field(parts[3], 1, 12)?,
        day_of_week: parse_cron_field(parts[4], 0, 7)?,
    })
}

fn parse_cron_field(field: &str, min: u32, max: u32) -> anyhow::Result<BTreeSet<u32>> {
    let mut values = BTreeSet::new();
    for part in field.split(',') {
        if part.is_empty() {
            anyhow::bail!("Invalid cron field: {field}");
        }
        let (range_text, step_text) = match part.split_once('/') {
            Some((range, step)) => (range, Some(step)),
            None => (part, None),
        };
        let step = match step_text {
            None => 1,
            Some(step) => parse_cron_number(Some(step), 1, max)?,
        };
        let (start, end) = if range_text == "*" {
            (min, max)
        } else if let Some((start_text, end_text)) = range_text.split_once('-') {
            let start = parse_cron_number(Some(start_text), min, max)?;
            let end = parse_cron_number(Some(end_text), min, max)?;
            if start > end {
                anyhow::bail!("Invalid cron range: {range_text}");
            }
            (start, end)
        } else {
            let value = parse_cron_number(Some(range_text), min, max)?;
            (value, value)
        };
        let mut value = start;
        while value <= end {
            values.insert(value);
            value += step;
        }
    }
    Ok(values)
}

fn parse_cron_number(value: Option<&str>, min: u32, max: u32) -> anyhow::Result<u32> {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        anyhow::bail!("Invalid cron number: ");
    };
    if !value.chars().all(|char| char.is_ascii_digit()) {
        anyhow::bail!("Invalid cron number: {value}");
    }
    let parsed: u32 = value
        .parse()
        .map_err(|_| anyhow::anyhow!("Invalid cron number: {value}"))?;
    if parsed < min || parsed > max {
        anyhow::bail!("Cron number out of range: {value}");
    }
    Ok(parsed)
}

/// UTC civil-time matching for the five-field cron expression.
fn matches_cron_fields(timestamp_ms: u64, fields: &CronFields) -> bool {
    let (minute, hour, day, month, weekday) = civil_time(timestamp_ms);
    let day_matches =
        fields.day_of_week.contains(&weekday) || (weekday == 0 && fields.day_of_week.contains(&7));
    fields.minute.contains(&minute)
        && fields.hour.contains(&hour)
        && fields.day_of_month.contains(&day)
        && fields.month.contains(&month)
        && day_matches
}

/// (minute, hour, day-of-month, month, weekday) in UTC. Weekday: 0=Sunday.
fn civil_time(timestamp_ms: u64) -> (u32, u32, u32, u32, u32) {
    let days = timestamp_ms / (24 * 60 * ONE_MINUTE_MS);
    let seconds_of_day = (timestamp_ms % (24 * 60 * ONE_MINUTE_MS)) / ONE_SECOND_MS;
    let minute = (seconds_of_day / 60) % 60;
    let hour = seconds_of_day / 3600;
    // Civil date from days-since-epoch (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    let weekday = ((days + 4) % 7) as u32; // 1970-01-01 was a Thursday.
    let _ = year;
    (
        minute as u32,
        hour as u32,
        day as u32,
        month as u32,
        weekday,
    )
}

fn normalize_cron_alias(text: &str) -> String {
    match text {
        "@hourly" => "0 * * * *".to_string(),
        "@daily" => "0 0 * * *".to_string(),
        "@weekly" => "0 0 * * 0".to_string(),
        "@monthly" => "0 0 1 * *".to_string(),
        _ => text.to_string(),
    }
}

fn strip_matching_quotes(value: &str) -> &str {
    let bytes = value.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return &value[1..value.len() - 1];
        }
    }
    value
}

/// ISO-8601 parse to epoch millis (RFC 3339 subset).
pub(crate) fn parse_iso_millis(text: &str) -> Option<u64> {
    // Delegate to time-like parsing: chrono is available via pa-ai? Keep a
    // small parser for the common ISO shapes.
    let text = text.trim();
    let (date, time) = text.split_once('T')?;
    let date_parts: Vec<&str> = date.split('-').collect();
    if date_parts.len() != 3 {
        return None;
    }
    let year: i64 = date_parts[0].parse().ok()?;
    let month: u32 = date_parts[1].parse().ok()?;
    let day: u32 = date_parts[2].parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    // Days since epoch via civil-date inverse.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if month > 2 { month - 3 } else { month + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let (time, offset_ms) = parse_time_with_offset(time)?;
    let millis = days * 24 * 60 * 60 * 1000 + time - offset_ms;
    Some(millis as u64)
}

/// Time-of-day parse: HH:MM[:SS[.fff]][Z|(+/-HH:MM)] -> millis + offset.
fn parse_time_with_offset(time: &str) -> Option<(i64, i64)> {
    let (time, offset) = if let Some(stripped) = time.strip_suffix('Z') {
        (stripped, 0i64)
    } else if let Some(index) = time
        .rfind('+')
        .or_else(|| time[1..].rfind('-').map(|i| i + 1))
    {
        let offset = parse_offset(&time[index..])?;
        (&time[..index], offset)
    } else {
        (time, 0)
    };
    let parts: Vec<&str> = time.split(':').collect();
    if parts.is_empty() || parts.len() > 3 {
        return None;
    }
    let hours: i64 = parts.first()?.parse().ok()?;
    let minutes: i64 = parts.get(1).map_or(Some(0), |p| p.parse::<i64>().ok())?;
    let seconds_part = parts.get(2).copied().unwrap_or("0");
    let (seconds, millis) = match seconds_part.split_once('.') {
        Some((seconds, fraction)) => {
            let seconds: i64 = seconds.parse().ok()?;
            let fraction_ms = fraction_pad(fraction)?;
            (seconds, fraction_ms)
        }
        None => (seconds_part.parse().ok()?, 0),
    };
    if hours > 23 || minutes > 59 || seconds > 59 {
        return None;
    }
    Some((
        hours * 3_600_000 + minutes * 60_000 + seconds * 1000 + millis,
        offset,
    ))
}

fn fraction_pad(fraction: &str) -> Option<i64> {
    if fraction.is_empty() || !fraction.chars().all(|char| char.is_ascii_digit()) {
        return None;
    }
    let mut padded = fraction.to_string();
    while padded.len() < 3 {
        padded.push('0');
    }
    let mut value = padded[..3].parse::<i64>().ok()?;
    let _ = &mut value;
    Some(value)
}

fn parse_offset(text: &str) -> Option<i64> {
    let (sign, rest) = match text.strip_prefix('+') {
        Some(rest) => (1i64, rest),
        None => text.strip_prefix('-').map(|rest| (-1i64, rest))?,
    };
    let parts: Vec<&str> = rest.split(':').collect();
    let hours: i64 = parts.first()?.parse().ok()?;
    let minutes: i64 = parts.get(1).map_or(Some(0), |p| p.parse::<i64>().ok())?;
    Some(sign * (hours * 60 + minutes) * 60_000)
}

/// Whether a job is due at `now_millis`.
pub fn is_due_job(job: &AgentCronJob, now_millis: u64) -> bool {
    if job.status != JobStatus::Active {
        return false;
    }
    job.next_run_at
        .as_deref()
        .and_then(parse_iso_millis)
        .is_some_and(|next| next <= now_millis)
}

#[allow(unused)]
fn unused(chr_value: char) -> char {
    chr_value
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: u64 = 1_700_000_000_000; // 2023-11-14T22:13:20Z

    #[test]
    fn parse_one_shot_and_interval_schedules() {
        let (schedule, next) = parse_agent_cron_schedule("in 10m", BASE).unwrap();
        assert_eq!(schedule.kind, ScheduleKind::Once);
        assert_eq!(next, BASE + 600_000);
        let (schedule, next) = parse_agent_cron_schedule("IN 2H", BASE).unwrap();
        assert_eq!(schedule.kind, ScheduleKind::Once);
        assert_eq!(next, BASE + 7_200_000);
        let (schedule, next) = parse_agent_cron_schedule("each 30s", BASE).unwrap();
        assert_eq!(schedule.kind, ScheduleKind::Interval);
        assert_eq!(schedule.interval_ms, Some(30_000));
        assert_eq!(next, BASE + 30_000);
        // Too-short intervals are rejected.
        assert!(parse_agent_cron_schedule("every 5s", BASE)
            .unwrap_err()
            .to_string()
            .contains("at least 10 seconds"));
        assert!(parse_agent_cron_schedule("", BASE).is_err());
        // `at` one-shot.
        let (_, next) = parse_agent_cron_schedule("at 2100-01-01T00:00:00Z", BASE).unwrap();
        assert_eq!(next, 4_102_444_800_000);
        assert!(parse_agent_cron_schedule("at 1999-01-01T00:00:00Z", BASE).is_err());
        // Quoted schedules are unwrapped.
        let (schedule, _) = parse_agent_cron_schedule("'in 10m'", BASE).unwrap();
        assert_eq!(schedule.expression, "in 10m");
    }

    #[test]
    fn cron_expressions_evaluate() {
        // @hourly fires at the next whole hour.
        let (schedule, next) = parse_agent_cron_schedule("@hourly", BASE).unwrap();
        assert_eq!(schedule.kind, ScheduleKind::Cron);
        assert_eq!(schedule.expression, "0 * * * *");
        let (minute, hour, _, _, _) = civil_time(next);
        assert_eq!((minute, hour), (0, 23));
        // Five-field: daily at noon.
        let (_, next) = parse_agent_cron_schedule("0 12 * * *", BASE).unwrap();
        let (minute, hour, _, _, _) = civil_time(next);
        assert_eq!((minute, hour), (0, 12));
        // Lists and steps.
        let (_, next) = parse_agent_cron_schedule("*/15 9-17 * * 1-5", BASE).unwrap();
        let (minute, _, _, _, weekday) = civil_time(next);
        assert_eq!(minute % 15, 0);
        assert!((1..=5).contains(&weekday));
        // Day-of-week 7 matches Sunday.
        let fields = parse_cron_expression("0 0 * * 7").unwrap();
        assert!(matches_cron_fields(4_102_617_600_000, &fields)); // a Sunday
                                                                  // Invalid expressions error clearly.
        assert!(parse_agent_cron_schedule("* * * *", BASE).is_err());
        assert!(parse_agent_cron_schedule("60 * * * *", BASE).is_err());
        assert!(parse_agent_cron_schedule("a * * * *", BASE).is_err());
    }

    #[test]
    fn next_run_rollover() {
        let (_, next) = parse_agent_cron_schedule("@daily", BASE).unwrap();
        // The schedule after the first run is one day later.
        let schedule = AgentCronSchedule {
            kind: ScheduleKind::Cron,
            expression: "0 0 * * *".to_string(),
            interval_ms: None,
        };
        assert_eq!(
            next_run_at_for_schedule(&schedule, next).unwrap(),
            Some(next + 24 * 60 * ONE_MINUTE_MS)
        );
        // Intervals roll by their delta; once never reruns.
        let interval = AgentCronSchedule {
            kind: ScheduleKind::Interval,
            expression: "every 10m".to_string(),
            interval_ms: Some(600_000),
        };
        assert_eq!(
            next_run_at_for_schedule(&interval, BASE).unwrap(),
            Some(BASE + 600_000)
        );
        let once = AgentCronSchedule {
            kind: ScheduleKind::Once,
            expression: "in 10m".to_string(),
            interval_ms: None,
        };
        assert_eq!(next_run_at_for_schedule(&once, BASE).unwrap(), None);
    }

    #[test]
    fn heartbeat_command_parsing() {
        use ParsedHeartbeatCommand::*;
        assert_eq!(parse_heartbeat_command("status").unwrap(), Status);
        assert_eq!(parse_heartbeat_command("/heartbeat").unwrap(), Status);
        assert_eq!(
            parse_heartbeat_command("/heartbeat status").unwrap(),
            Status
        );
        assert_eq!(parse_heartbeat_command("/heartbeat pause").unwrap(), Pause);
        assert_eq!(
            parse_heartbeat_command("/heartbeat resume").unwrap(),
            Resume
        );
        assert_eq!(parse_heartbeat_command("/heartbeat stop").unwrap(), Clear);
        // Bare instruction uses the default schedule.
        let Set {
            schedule,
            instruction,
            delivery_mode,
        } = parse_heartbeat_command("/heartbeat check the build").unwrap()
        else {
            panic!("expected set");
        };
        assert_eq!(schedule, "every 5m");
        assert_eq!(instruction, "check the build");
        assert_eq!(delivery_mode, None);
        // --every with bare and quoted values.
        let Set {
            schedule,
            instruction,
            ..
        } = parse_heartbeat_command("/heartbeat --every 10m keep going").unwrap()
        else {
            panic!("expected set");
        };
        assert_eq!(schedule, "every 10m");
        assert_eq!(instruction, "keep going");
        let Set {
            schedule,
            instruction,
            ..
        } = parse_heartbeat_command("/heartbeat --every=\"15 m\" watch things").unwrap()
        else {
            panic!("expected set");
        };
        assert_eq!(schedule, "every 15 m");
        assert_eq!(instruction, "watch things");
        // Leading schedule form.
        let Set {
            schedule,
            instruction,
            ..
        } = parse_heartbeat_command("/heartbeat every 2h sweep logs").unwrap()
        else {
            panic!("expected set");
        };
        assert_eq!(schedule, "every 2h");
        assert_eq!(instruction, "sweep logs");
        // Delivery flags: leading, trailing, and --deliver forms.
        let Set { delivery_mode, .. } =
            parse_heartbeat_command("/heartbeat --steer --every 5m ping").unwrap()
        else {
            panic!("expected set");
        };
        assert_eq!(delivery_mode, Some(DeliveryMode::Steer));
        let Set { delivery_mode, .. } =
            parse_heartbeat_command("/heartbeat --every 5m ping --follow-up").unwrap()
        else {
            panic!("expected set");
        };
        assert_eq!(delivery_mode, Some(DeliveryMode::FollowUp));
        let Set { delivery_mode, .. } =
            parse_heartbeat_command("/heartbeat --deliver=steer --every 5m ping").unwrap()
        else {
            panic!("expected set");
        };
        assert_eq!(delivery_mode, Some(DeliveryMode::Steer));
        let Set { delivery_mode, .. } =
            parse_heartbeat_command("/heartbeat --deliver follow_up --every 5m ping").unwrap()
        else {
            panic!("expected set");
        };
        assert_eq!(delivery_mode, Some(DeliveryMode::FollowUp));
        // Missing instruction.
        assert!(parse_heartbeat_command("/heartbeat --every 10m").is_err());
    }

    #[test]
    fn heartbeat_deferral_rules() {
        let job = |source: &str, mode: Option<DeliveryMode>| AgentCronJob {
            id: "j1".to_string(),
            status: JobStatus::Active,
            source: Some(source.to_string()),
            runtime_kind: Some("top-level".to_string()),
            delivery_mode: mode,
            active_session_id: "active".to_string(),
            session_id: "session".to_string(),
            session_file: "/s/file.jsonl".to_string(),
            cwd: "/w".to_string(),
            label: None,
            schedule: AgentCronSchedule {
                kind: ScheduleKind::Interval,
                expression: "every 5m".to_string(),
                interval_ms: Some(300_000),
            },
            created_at: String::new(),
            updated_at: String::new(),
            next_run_at: Some("2000-01-01T00:00:00Z".to_string()),
            last_run_at: None,
            last_skipped_at: None,
            run_count: 0,
            prompt: "ping".to_string(),
            last_error: None,
        };
        let idle = HeartbeatSessionActivity::default();
        let streaming = HeartbeatSessionActivity {
            is_streaming: true,
            ..Default::default()
        };
        // Non-heartbeat jobs never defer.
        assert!(!should_defer_heartbeat_cron_job(
            &job("cron", None),
            &streaming
        ));
        // Steer heartbeats fire during streaming; follow-up waits.
        assert!(!should_defer_heartbeat_cron_job(
            &job("heartbeat", Some(DeliveryMode::Steer)),
            &streaming
        ));
        assert!(should_defer_heartbeat_cron_job(
            &job("heartbeat", Some(DeliveryMode::FollowUp)),
            &streaming
        ));
        // Busy states defer regardless of mode.
        let compacting = HeartbeatSessionActivity {
            is_compacting: true,
            is_streaming: true,
            ..Default::default()
        };
        assert!(should_defer_heartbeat_cron_job(
            &job("heartbeat", Some(DeliveryMode::Steer)),
            &compacting
        ));
        let unfinished = HeartbeatSessionActivity {
            unfinished_action_count: 2,
            ..Default::default()
        };
        assert!(should_defer_heartbeat_cron_job(
            &job("rlm_heartbeat", None),
            &unfinished
        ));
        // Idle heartbeats fire.
        assert!(!should_defer_heartbeat_cron_job(
            &job("heartbeat", None),
            &idle
        ));
    }

    #[test]
    fn due_jobs_and_formatting() {
        let mut job = AgentCronJob {
            id: "job1".to_string(),
            status: JobStatus::Active,
            source: Some("cron".to_string()),
            runtime_kind: Some("top-level".to_string()),
            delivery_mode: None,
            active_session_id: "active".to_string(),
            session_id: "session".to_string(),
            session_file: "/s/file.jsonl".to_string(),
            cwd: "/w".to_string(),
            created_at: String::new(),
            updated_at: String::new(),
            label: Some("sweep".to_string()),
            schedule: AgentCronSchedule {
                kind: ScheduleKind::Interval,
                expression: "every 5m".to_string(),
                interval_ms: Some(300_000),
            },
            next_run_at: Some("2000-01-01T00:00:00Z".to_string()),
            last_run_at: None,
            last_skipped_at: None,
            run_count: 3,
            prompt: "keep   working".to_string(),
            last_error: Some("boom".to_string()),
        };
        assert!(is_due_job(&job, 946_684_800_001));
        assert!(!is_due_job(&job, 946_684_799_999));
        job.status = JobStatus::Paused;
        assert!(!is_due_job(&job, 946_684_800_001));
        job.status = JobStatus::Active;
        let formatted = format_agent_cron_job(&job);
        assert!(formatted.starts_with("job1 active label=\"sweep\" next=2000-01-01T00:00:00Z"));
        assert!(
            formatted.contains("runs=3 schedule=\"every 5m\" prompt=\"keep working\" error=boom")
        );
    }
}
