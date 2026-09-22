//! Session slash-command argument parsing and status formatting for `/goal`
//! and `/autonomous`. Ports of agent-session.ts `_parseGoalSlashCommand`,
//! `_parseAutonomousSlashCommand`, `parseAutonomousBudgetOptions`, and
//! `_formatAutonomousStatus`; the strings are user-facing and byte-identical.

use crate::autonomous::{AgentAutonomousConfig, AgentAutonomousStatus, UNLIMITED_AUTONOMOUS_LIMIT};
use crate::goals::{validate_goal_objective, MAX_THREAD_GOAL_OBJECTIVE_CHARS};
use crate::skills::parse_command_args;

pub const AUTONOMOUS_BUDGET_USAGE: &str = "Usage: /autonomous [status|off] or /autonomous on [--max-continuations <n|unlimited>] [--max-turns <n|unlimited>] [--max-tokens <n|unlimited>] [--timeout-ms <n|unlimited>] [--gate <command>] [--gate-retries <n>] [--gate-timeout-ms <n>] [--subagent-keep-alive-ms <n>]";

/// A parsed `/goal` argument string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GoalCommand {
    Status,
    Clear,
    Pause,
    Resume,
    Start {
        objective: String,
        token_budget: Option<u64>,
    },
}

/// Parse `/goal [status|clear|stop|pause|resume|[--budget <tokens>] <objective>]`.
pub fn parse_goal_command(args: &str) -> Result<GoalCommand, String> {
    let rest = args.trim();
    let normalized = rest.to_lowercase();
    if rest.is_empty() || normalized == "status" {
        return Ok(GoalCommand::Status);
    }
    if normalized == "clear" || normalized == "stop" {
        return Ok(GoalCommand::Clear);
    }
    if normalized == "pause" {
        return Ok(GoalCommand::Pause);
    }
    if normalized == "resume" {
        return Ok(GoalCommand::Resume);
    }
    let first_token = rest.split(char::is_whitespace).next().unwrap_or_default();
    let mut token_budget = None;
    let mut objective = rest.to_string();
    if first_token == "--budget"
        || first_token == "--token-budget"
        || first_token.starts_with("--budget=")
        || first_token.starts_with("--token-budget=")
    {
        let (value_text, objective_rest) =
            if first_token.starts_with("--budget=") || first_token.starts_with("--token-budget=") {
                let separator = first_token.find('=').expect("checked prefix contains =");
                let value_text = &first_token[separator + 1..];
                (
                    value_text.to_string(),
                    rest[first_token.len()..].trim().to_string(),
                )
            } else {
                let without_flag = rest[first_token.len()..].trim_start();
                match without_flag.find(char::is_whitespace) {
                    None => {
                        return Err("Usage: /goal [--budget <tokens>] <objective>".to_string());
                    }
                    Some(space) => (
                        without_flag[..space].to_string(),
                        without_flag[space + 1..].trim().to_string(),
                    ),
                }
            };
        token_budget = Some(parse_goal_budget_value(&value_text)?);
        objective = objective_rest;
    }
    let objective = validate_goal_objective(&objective).map_err(|error| format!("{error}"))?;
    let _ = MAX_THREAD_GOAL_OBJECTIVE_CHARS;
    Ok(GoalCommand::Start {
        objective,
        token_budget,
    })
}

/// `parseGoalBudgetValue`: a positive integer.
fn parse_goal_budget_value(value: &str) -> Result<u64, String> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) || value.starts_with('0') {
        return Err("Goal token budget must be a positive integer.".to_string());
    }
    match value.parse::<u64>() {
        Ok(budget) if budget > 0 => Ok(budget),
        _ => Err("Goal token budget must be a positive integer.".to_string()),
    }
}

/// A parsed `/autonomous` argument string.
#[derive(Debug, Clone, PartialEq)]
pub enum AutonomousCommand {
    Status,
    On { config: AgentAutonomousConfig },
    Off,
}

/// Parse `/autonomous [status|off|on [--max-continuations <n>] ...]`.
pub fn parse_autonomous_command(args: &str) -> Result<AutonomousCommand, String> {
    let tokens = parse_command_args(args);
    if tokens.is_empty() || tokens[0].to_lowercase() == "status" {
        if tokens.len() > 1 {
            return Err(format!(
                "Unexpected autonomous argument: {}. {AUTONOMOUS_BUDGET_USAGE}",
                tokens[1]
            ));
        }
        return Ok(AutonomousCommand::Status);
    }
    let subcommand = tokens[0].to_lowercase();
    if subcommand == "on" || subcommand == "enable" || subcommand == "enabled" {
        return Ok(AutonomousCommand::On {
            config: parse_autonomous_budget_options(&tokens[1..])?,
        });
    }
    if subcommand == "off" || subcommand == "disable" || subcommand == "disabled" {
        if tokens.len() > 1 {
            return Err(format!(
                "Unexpected autonomous argument: {}. {AUTONOMOUS_BUDGET_USAGE}",
                tokens[1]
            ));
        }
        return Ok(AutonomousCommand::Off);
    }
    Err(AUTONOMOUS_BUDGET_USAGE.to_string())
}

/// `/autonomous` budget flags mirror the `--autonomous-*` CLI options; the
/// CLI spelling is accepted as an alias.
const AUTONOMOUS_BUDGET_FLAGS: [&str; 8] = [
    "max-continuations",
    "max-turns",
    "max-tokens",
    "timeout-ms",
    "gate",
    "gate-retries",
    "gate-timeout-ms",
    "subagent-keep-alive-ms",
];

/// `parseAutonomousBudgetOptions`: `--flag value` and `--flag=value` pairs.
pub fn parse_autonomous_budget_options(tokens: &[String]) -> Result<AgentAutonomousConfig, String> {
    let mut config = AgentAutonomousConfig::default();
    let mut gate_commands: Vec<String> = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        let token = &tokens[index];
        if !token.starts_with("--") {
            return Err(format!(
                "Unexpected autonomous argument: {token}. {AUTONOMOUS_BUDGET_USAGE}"
            ));
        }
        let (raw_flag, inline_value) = match token.find('=') {
            Some(equals) => (&token[..equals], Some(token[equals + 1..].to_string())),
            None => (token.as_str(), None),
        };
        let flag = raw_flag
            .strip_prefix("--autonomous-")
            .unwrap_or(raw_flag.strip_prefix("--").unwrap_or(raw_flag));
        if !AUTONOMOUS_BUDGET_FLAGS.contains(&flag) {
            return Err(format!(
                "Unknown autonomous budget flag: {raw_flag}. {AUTONOMOUS_BUDGET_USAGE}"
            ));
        }
        let mut value = inline_value;
        if value.is_none() {
            let next = tokens.get(index + 1);
            match next {
                None => {
                    return Err(format!(
                        "Missing value for {raw_flag}. {AUTONOMOUS_BUDGET_USAGE}"
                    ));
                }
                Some(next) if next.starts_with("--") => {
                    return Err(format!(
                        "Missing value for {raw_flag}. {AUTONOMOUS_BUDGET_USAGE}"
                    ));
                }
                Some(next) => {
                    value = Some(next.clone());
                    index += 1;
                }
            }
        }
        let value = value
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("Missing value for {raw_flag}. {AUTONOMOUS_BUDGET_USAGE}"))?;
        match flag {
            "gate" => gate_commands.push(value),
            "gate-retries" => {
                let gates = config.gates.get_or_insert_with(Default::default);
                gates.max_retries = Some(parse_budget_int(flag, &value, false)?);
            }
            "gate-timeout-ms" => {
                let gates = config.gates.get_or_insert_with(Default::default);
                gates.timeout_ms = Some(parse_budget_int(flag, &value, false)?);
            }
            "max-continuations" => {
                config.max_continuations = Some(parse_budget_int(flag, &value, true)?);
            }
            "max-turns" => config.max_turns = Some(parse_budget_int(flag, &value, true)?),
            "max-tokens" => config.max_tokens = Some(parse_budget_int(flag, &value, true)?),
            "timeout-ms" => config.timeout_ms = Some(parse_budget_int(flag, &value, true)?),
            "subagent-keep-alive-ms" => {
                config.subagent_keep_alive_ms = Some(parse_subagent_keep_alive_ms(&value)?);
            }
            _ => unreachable!("flag membership checked above"),
        }
        index += 1;
    }
    if !gate_commands.is_empty() {
        let gates = config.gates.get_or_insert_with(Default::default);
        gates.commands = Some(gate_commands);
    }
    // Named budget flags define the whole budget: any limit the user did not
    // name stops cutting the run short. With no budget flags at all, the
    // configured or default limits still apply.
    if config.max_continuations.is_some()
        || config.max_turns.is_some()
        || config.max_tokens.is_some()
        || config.timeout_ms.is_some()
    {
        config.max_continuations = config
            .max_continuations
            .or(Some(UNLIMITED_AUTONOMOUS_LIMIT));
        config.max_turns = config.max_turns.or(Some(UNLIMITED_AUTONOMOUS_LIMIT));
        config.max_tokens = config.max_tokens.or(Some(UNLIMITED_AUTONOMOUS_LIMIT));
        config.timeout_ms = config.timeout_ms.or(Some(UNLIMITED_AUTONOMOUS_LIMIT));
    }
    Ok(config)
}

/// `parseAutonomousBudgetInt`: positive integer, commas/underscores accepted
/// as digit separators, `unlimited` when allowed.
fn parse_budget_int(flag: &str, value: &str, allow_unlimited: bool) -> Result<u64, String> {
    if allow_unlimited && value.to_lowercase() == "unlimited" {
        return Ok(UNLIMITED_AUTONOMOUS_LIMIT);
    }
    let digits: String = value.chars().filter(|c| *c != ',' && *c != '_').collect();
    if digits.is_empty() || digits.starts_with('0') || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!(
            "--{flag} must be a positive integer{}. {AUTONOMOUS_BUDGET_USAGE}",
            if allow_unlimited {
                " or \"unlimited\""
            } else {
                ""
            }
        ));
    }
    digits.parse::<u64>().map_err(|_| {
        format!(
            "--{flag} must be a positive integer{}. {AUTONOMOUS_BUDGET_USAGE}",
            if allow_unlimited {
                " or \"unlimited\""
            } else {
                ""
            }
        )
    })
}

/// Keep-alive windows accept 0 (disable the valve) or a positive integer.
fn parse_subagent_keep_alive_ms(value: &str) -> Result<u64, String> {
    let digits: String = value.chars().filter(|c| *c != ',' && *c != '_').collect();
    if digits == "0" {
        return Ok(0);
    }
    if !digits.is_empty() && !digits.starts_with('0') && digits.bytes().all(|b| b.is_ascii_digit())
    {
        if let Ok(parsed) = digits.parse::<u64>() {
            if parsed <= crate::autonomous::MAX_SUBAGENT_KEEP_ALIVE_MS {
                return Ok(parsed);
            }
        }
    }
    Err(format!(
        "--subagent-keep-alive-ms must be 0 or a positive integer up to {}. {AUTONOMOUS_BUDGET_USAGE}",
        crate::autonomous::MAX_SUBAGENT_KEEP_ALIVE_MS
    ))
}

/// `formatCount` for autonomous status values: unlimited or en-US grouping.
fn format_count(value: u64) -> String {
    if value == UNLIMITED_AUTONOMOUS_LIMIT {
        "unlimited".to_string()
    } else {
        let mut grouped = String::new();
        let digits = value.to_string();
        for (index, digit) in digits.chars().enumerate() {
            if index > 0 && (digits.len() - index).is_multiple_of(3) {
                grouped.push(',');
            }
            grouped.push(digit);
        }
        grouped
    }
}

/// `_formatAutonomousStatus`: the `[autonomous-status: ...]` block.
pub fn format_autonomous_status(status: &AgentAutonomousStatus) -> String {
    let state = if status.enabled { "on" } else { "off" };
    let elapsed_seconds = status
        .started_at
        .map(|started_at| now_millis().saturating_sub(started_at) / 1000)
        .unwrap_or(0);
    let gate_summary = if status.gates.commands.is_empty() {
        "none".to_string()
    } else {
        status
            .gates
            .commands
            .iter()
            .map(|command| format!("\"{command}\""))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let time_budget = if status.limits.timeout_ms == UNLIMITED_AUTONOMOUS_LIMIT {
        "unlimited".to_string()
    } else {
        format!("{}s", format_count(status.limits.timeout_ms / 1000))
    };
    let subagent_keep_alive_ms = status.subagent_keep_alive_ms.unwrap_or(0);
    let keep_alive = if subagent_keep_alive_ms > 0 {
        if subagent_keep_alive_ms >= 60_000 {
            format!("{}m", format_count(subagent_keep_alive_ms / 60_000))
        } else {
            format!("{}ms", format_count(subagent_keep_alive_ms))
        }
    } else {
        "off".to_string()
    };
    format!(
        "[autonomous-status: {state}]\n\nContinuations: {}/{}. Turns: {}/{}. Tokens: {}/{}. Time: {elapsed_seconds}s/{time_budget}. Gates: {gate_summary}. Subagent keep-alive: {keep_alive}.",
        format_count(status.continuations_used),
        format_count(status.limits.max_continuations),
        format_count(status.turns_used),
        format_count(status.limits.max_turns),
        format_count(status.tokens_used),
        format_count(status.limits.max_tokens),
    )
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn goal_command_kinds() {
        assert_eq!(parse_goal_command("").unwrap(), GoalCommand::Status);
        assert_eq!(parse_goal_command("status").unwrap(), GoalCommand::Status);
        assert_eq!(parse_goal_command("stop").unwrap(), GoalCommand::Clear);
        assert_eq!(parse_goal_command("PAUSE").unwrap(), GoalCommand::Pause);
        assert_eq!(parse_goal_command("resume").unwrap(), GoalCommand::Resume);
        assert_eq!(
            parse_goal_command("ship the feature").unwrap(),
            GoalCommand::Start {
                objective: "ship the feature".to_string(),
                token_budget: None,
            }
        );
        assert_eq!(
            parse_goal_command("--budget 5000 keep going").unwrap(),
            GoalCommand::Start {
                objective: "keep going".to_string(),
                token_budget: Some(5000),
            }
        );
        assert_eq!(
            parse_goal_command("--token-budget=300 fix it").unwrap(),
            GoalCommand::Start {
                objective: "fix it".to_string(),
                token_budget: Some(300),
            }
        );
        assert_eq!(
            parse_goal_command("--budget").unwrap_err(),
            "Usage: /goal [--budget <tokens>] <objective>"
        );
        assert_eq!(
            parse_goal_command("--budget 0x10 nope").unwrap_err(),
            "Goal token budget must be a positive integer."
        );
        assert_eq!(parse_goal_command("").unwrap(), GoalCommand::Status,);
    }

    #[test]
    fn autonomous_command_kinds() {
        assert_eq!(
            parse_autonomous_command("").unwrap(),
            AutonomousCommand::Status
        );
        assert_eq!(
            parse_autonomous_command("STATUS").unwrap(),
            AutonomousCommand::Status
        );
        assert_eq!(
            parse_autonomous_command("off").unwrap(),
            AutonomousCommand::Off
        );
        let AutonomousCommand::On { config } = parse_autonomous_command("on").unwrap() else {
            panic!("expected on");
        };
        assert_eq!(config, AgentAutonomousConfig::default());
        let AutonomousCommand::On { config } =
            parse_autonomous_command("on --max-turns 5 --max-tokens 1,000").unwrap()
        else {
            panic!("expected on");
        };
        assert_eq!(config.max_turns, Some(5));
        assert_eq!(config.max_tokens, Some(1_000));
        // Unnamed limits become unlimited once one limit is named.
        assert_eq!(config.max_continuations, Some(UNLIMITED_AUTONOMOUS_LIMIT));
        assert_eq!(
            parse_autonomous_command("bogus").unwrap_err(),
            AUTONOMOUS_BUDGET_USAGE
        );
        assert_eq!(
            parse_autonomous_command("status extra").unwrap_err(),
            format!("Unexpected autonomous argument: extra. {AUTONOMOUS_BUDGET_USAGE}")
        );
        assert!(parse_autonomous_command("on --nope 1")
            .unwrap_err()
            .starts_with("Unknown autonomous budget flag: --nope."));
    }

    #[test]
    fn autonomous_status_format() {
        let state = crate::autonomous::create_autonomous_runtime_state(None, None);
        let status = crate::autonomous::autonomous_status(&state);
        let text = format_autonomous_status(&status);
        assert!(text.starts_with("[autonomous-status: off]"));
        assert!(text.contains("Continuations: 0/3. Turns: 0/12. Tokens: 0/80,000."));
        assert!(text.contains("Time: 0s/1,800s. Gates: none. Subagent keep-alive: 25m."));
    }
}
