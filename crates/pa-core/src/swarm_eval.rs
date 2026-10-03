//! Swarm starvation eval harness: defense-line accounting + reporting.
//!
//! Port of the TS-era swarm starvation eval lane (#2353, stacked on the
//! messaging-instrumentation lane #2352). The design position: the question
//! "at what crew size does direct agent-to-agent steering starve orchestrator
//! context?" is answered by measurement, not intuition. A trial runs a real
//! orchestrator session whose children reply over the agent-message path, and
//! each trial's messaging snapshot is scored against three pre-registered
//! defense lines:
//!
//! | Line | Limit | Metric |
//! | --- | --- | --- |
//! | Context | `<= 25%` | estimated agent-message tokens over working-context tokens |
//! | Turns | `<= 1/3` | agent-triggered model steps over all model steps |
//! | Cost | `<= 20%` | ingestion-step usage tokens over all step usage tokens |
//!
//! Boundaries are inclusive. Any crossed line fails; any unknown line is
//! inconclusive (never a silent pass). This module owns the deterministic
//! half of the harness - the defense lines, the config/argument surface, the
//! prompts, the ANSWER verification, the trial verdict, and the report
//! rendering - so the driver and the unit battery share one source of truth.
//!
//! The messaging snapshot itself is produced by the session-level messaging
//! counters (the #2352 lane, `rlm.messaging_stats()`). Until that producer is
//! present, [`transcript::snapshot_from_transcript`] derives the same shape
//! from the session transcript the daemon already serves.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub mod transcript;

/// The default crew sizes the eval sweeps.
pub const DEFAULT_SIZES: &[usize] = &[2, 5, 10, 20, 40];

/// The largest supported crew size. The secrets are 3-digit (100..1000),
/// so at most 900 children can hold pairwise-unique secrets; past that the
/// ANSWER verification the harness is built on degrades, and a sweep that
/// large could not hold a real context window anyway.
pub const MAX_CREW_SIZE: usize = 900;

/// Pre-registered defense lines for the swarm starvation eval: a config is
/// defensible only if all three lines hold.
pub const MESSAGING_DEFENSE_LINE_LIMITS: MessagingDefenseLineLimits = MessagingDefenseLineLimits {
    // Agent-message share of working context.
    context_share: 0.25,
    // Agent-triggered model steps over all model steps.
    turn_share: 1.0 / 3.0,
    // Ingestion-step usage tokens over all step usage tokens.
    cost_share: 0.2,
};

/// Thresholds for the three defense lines, overridable per call.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MessagingDefenseLineLimits {
    pub context_share: f64,
    pub turn_share: f64,
    pub cost_share: f64,
}

impl Default for MessagingDefenseLineLimits {
    fn default() -> Self {
        MESSAGING_DEFENSE_LINE_LIMITS
    }
}

/// One scored defense line: the measured value (absent when unmeasurable),
/// the limit it was scored against, and the outcome (`None` when unknown).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct MessagingDefenseLine {
    pub value: Option<f64>,
    pub limit: f64,
    pub passed: Option<bool>,
}

/// The three scored defense lines plus the folded verdict.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct MessagingDefenseLines {
    pub context_share: MessagingDefenseLine,
    pub turn_share: MessagingDefenseLine,
    pub cost_share: MessagingDefenseLine,
    /// `Fail` when any line failed, `Inconclusive` when any line is unknown
    /// and none failed, else `Pass`.
    pub verdict: DefenseVerdict,
}

/// A trial's (or defense-line set's) folded verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DefenseVerdict {
    Pass,
    Fail,
    Inconclusive,
}

impl DefenseVerdict {
    /// The lowercase wire/report token.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pass => "pass",
            Self::Fail => "fail",
            Self::Inconclusive => "inconclusive",
        }
    }
}

/// The per-session messaging snapshot the defense lines score. Mirrors the
/// `rlm.messaging_stats()` shape (the #2352 producer); the counters are the
/// session's arrival, step, and context totals plus the outbound send counts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct MessagingStatsSnapshot {
    pub arrivals: ArrivalCounts,
    pub model_steps: StepCounts,
    pub ingestion_steps: StepCounts,
    pub context: ContextShape,
    pub sends: SendCounts,
}

/// Accepted inbound agent messages (delivered or queued).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArrivalCounts {
    pub total: u64,
    pub last5m: u64,
}

/// Completed model steps (and their usage tokens).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepCounts {
    pub total: u64,
    pub last5m: u64,
    pub tokens: u64,
}

/// The agent-message share of the working context. `context_tokens` (and
/// therefore `share`) is unknown until an assistant usage is recorded.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct ContextShape {
    pub estimated_agent_message_tokens: u64,
    pub context_tokens: Option<u64>,
    pub share: Option<f64>,
}

/// Outbound `agent_message.send` attempts and failures.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendCounts {
    pub attempts: u64,
    pub failures: u64,
}

/// Score a messaging snapshot against the pre-registered defense lines.
#[must_use]
pub fn evaluate_messaging_defense_lines(
    snapshot: &MessagingStatsSnapshot,
    limits: MessagingDefenseLineLimits,
) -> MessagingDefenseLines {
    let context_line = score_line(snapshot.context.share, limits.context_share);
    let turn_line = score_line(turn_share(snapshot), limits.turn_share);
    let cost_line = score_line(cost_share(snapshot), limits.cost_share);
    let lines = [context_line, turn_line, cost_line];
    let verdict = if lines.iter().any(|line| line.passed == Some(false)) {
        DefenseVerdict::Fail
    } else if lines.iter().any(|line| line.passed.is_none()) {
        DefenseVerdict::Inconclusive
    } else {
        DefenseVerdict::Pass
    };
    MessagingDefenseLines {
        context_share: context_line,
        turn_share: turn_line,
        cost_share: cost_line,
        verdict,
    }
}

fn score_line(value: Option<f64>, limit: f64) -> MessagingDefenseLine {
    MessagingDefenseLine {
        value,
        limit,
        passed: value.map(|value| value <= limit),
    }
}

/// Agent-triggered model steps over all model steps (unknown with no steps).
#[must_use]
pub fn turn_share(snapshot: &MessagingStatsSnapshot) -> Option<f64> {
    (snapshot.model_steps.total > 0)
        .then(|| snapshot.ingestion_steps.total as f64 / snapshot.model_steps.total as f64)
}

/// Ingestion-step usage tokens over all step usage tokens (unknown with none).
#[must_use]
pub fn cost_share(snapshot: &MessagingStatsSnapshot) -> Option<f64> {
    (snapshot.model_steps.tokens > 0)
        .then(|| snapshot.ingestion_steps.tokens as f64 / snapshot.model_steps.tokens as f64)
}

/// Message size sweep axis: a short REPORT line or the 200-filler-line long
/// form.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageSize {
    Short,
    Long,
}

impl MessageSize {
    /// The lowercase wire/report token.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Short => "short",
            Self::Long => "long",
        }
    }
}

/// Arrival-pattern sweep axis: staggered child reply sleeps (`spread`) or
/// immediate replies (`burst`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArrivalPattern {
    Spread,
    Burst,
}

impl ArrivalPattern {
    /// The lowercase wire/report token.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Spread => "spread",
            Self::Burst => "burst",
        }
    }
}

/// One eval run's configuration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SwarmEvalConfig {
    pub model: String,
    pub sizes: Vec<usize>,
    pub message_size: MessageSize,
    pub pattern: ArrivalPattern,
    pub trials: usize,
    pub gap_seconds: f64,
    pub timeout_minutes: f64,
    pub out_dir: String,
    pub seed: i64,
}

/// The default configuration (model and out dir are filled by the caller).
///
/// The per-trial timeout is sized to the largest supported crew in the
/// default Spread pattern: the last child's staggered sleep alone waits
/// `(MAX_CREW_SIZE - 1) * gap_seconds` = 1,798s, and the poll must also
/// observe that reply plus the orchestrator's final ANSWER step, so the
/// default covers the full schedule plus a final-turn budget instead of
/// cutting supported sizes off mid-schedule.
#[must_use]
pub fn default_eval_config() -> SwarmEvalConfig {
    SwarmEvalConfig {
        model: String::new(),
        sizes: DEFAULT_SIZES.to_vec(),
        message_size: MessageSize::Short,
        pattern: ArrivalPattern::Spread,
        trials: 1,
        gap_seconds: 2.0,
        timeout_minutes: 35.0,
        out_dir: String::new(),
        seed: 1,
    }
}

/// Argument-parsing failure: `Help` is the explicit `--help` request, every
/// other case is a user-correctable message.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EvalArgsError {
    #[error("help")]
    Help,
    #[error("{0}")]
    Message(String),
}

/// Parse the driver's argv into a [`SwarmEvalConfig`].
///
/// # Errors
///
/// Returns [`EvalArgsError::Help`] for `--help`/`-h`, and
/// [`EvalArgsError::Message`] for an unknown flag, a flag missing its value,
/// a missing `--model`, a `--sizes` list with no positive size, a size
/// above [`MAX_CREW_SIZE`], or a sweep whose derived trial seed
/// (`seed + 31 * size + trial`) cannot be represented in `i64`. Non-finite
/// `--gap-seconds` values fall back to the immediate-reply zero.
pub fn parse_eval_args(argv: &[String]) -> Result<SwarmEvalConfig, EvalArgsError> {
    let mut config = default_eval_config();
    let mut index = 0;
    while index < argv.len() {
        let arg = argv[index].as_str();
        index += 1;
        match arg {
            "--model" => config.model = arg_value(argv, &mut index, arg)?.to_string(),
            "--sizes" => {
                config.sizes = arg_value(argv, &mut index, arg)?
                    .split(',')
                    .filter_map(|raw| raw.trim().parse::<usize>().ok())
                    .filter(|size| *size > 0)
                    .collect();
            }
            "--msg-size" => {
                config.message_size = match arg_value(argv, &mut index, arg)? {
                    "long" => MessageSize::Long,
                    _ => MessageSize::Short,
                };
            }
            "--pattern" => {
                config.pattern = match arg_value(argv, &mut index, arg)? {
                    "burst" => ArrivalPattern::Burst,
                    _ => ArrivalPattern::Spread,
                };
            }
            "--trials" => {
                let raw = arg_value(argv, &mut index, arg)?;
                config.trials = raw.parse::<usize>().unwrap_or(1).max(1);
            }
            "--gap-seconds" => {
                let raw = arg_value(argv, &mut index, arg)?;
                // Non-finite values (`1e999`, `inf`, `NaN`) would emit
                // `asyncio.sleep(inf)` — `NaN` for child 0 — into the child
                // prompts and stall every staggered reply; they fall back to
                // the immediate-reply zero like any unparsable value.
                config.gap_seconds = raw
                    .parse::<f64>()
                    .ok()
                    .filter(|value| value.is_finite())
                    .unwrap_or(0.0)
                    .max(0.0);
            }
            "--timeout-minutes" => {
                let raw = arg_value(argv, &mut index, arg)?;
                // `inf`/`infinity` (any case, any sign) explicitly remove the
                // per-trial timeout: `f64::parse` accepts them, and passing a
                // non-finite value through to a `Duration` conversion panics
                // mid-run. Only those spellings may open an unbounded wait:
                // an overflowing numeric literal (`1e999`) also parses to
                // infinity, so non-finite parses fall back to the clamped
                // default like any unparsable or sub-minute value.
                config.timeout_minutes = match raw.trim().to_ascii_lowercase().as_str() {
                    "inf" | "+inf" | "-inf" | "infinity" | "+infinity" | "-infinity" => {
                        f64::INFINITY
                    }
                    _ => raw
                        .parse::<f64>()
                        .ok()
                        .filter(|value| value.is_finite())
                        .unwrap_or(1.0)
                        .max(1.0),
                };
            }
            "--out" => config.out_dir = arg_value(argv, &mut index, arg)?.to_string(),
            "--seed" => {
                let raw = arg_value(argv, &mut index, arg)?;
                config.seed = raw.parse::<i64>().unwrap_or(0);
            }
            "--help" | "-h" => return Err(EvalArgsError::Help),
            other => {
                return Err(EvalArgsError::Message(format!("Unknown argument: {other}")));
            }
        }
    }
    if config.model.is_empty() {
        return Err(EvalArgsError::Message(
            "--model is required (provider/id)".to_string(),
        ));
    }
    if config.sizes.is_empty() {
        return Err(EvalArgsError::Message(
            "--sizes must contain at least one positive size".to_string(),
        ));
    }
    if let Some(&size) = config.sizes.iter().find(|&&size| size > MAX_CREW_SIZE) {
        return Err(EvalArgsError::Message(format!(
            "--sizes {size} exceeds the supported maximum crew size {MAX_CREW_SIZE}"
        )));
    }
    // The driver derives each trial's seed as `seed + 31 * size + trial`
    // (i64); reject a sweep whose largest trial cannot be represented
    // before the first real-token request is ever sent. A trial count that
    // cannot convert to i64 is its own error — clamping it would let a
    // negative-extreme seed hide the unrepresentable sweep (an effectively
    // unbounded trial loop through real tokens).
    let max_trial = i64::try_from(config.trials).map_err(|_| {
        EvalArgsError::Message(format!(
            "--trials {} cannot be represented in the derived trial seed (seed + 31 * size + trial)",
            config.trials
        ))
    })?;
    for &size in &config.sizes {
        let size_offset = i64::try_from(size).unwrap_or(i64::MAX);
        let derived =
            i128::from(config.seed) + i128::from(size_offset) * 31 + i128::from(max_trial);
        if derived > i128::from(i64::MAX) {
            return Err(EvalArgsError::Message(format!(
                "--seed {} with size {size} and {} trials overflows the derived trial seed (seed + 31 * size + trial)",
                config.seed, config.trials
            )));
        }
    }
    if config.out_dir.is_empty() {
        config.out_dir = default_out_dir();
    }
    Ok(config)
}

fn arg_value<'a>(
    argv: &'a [String],
    index: &mut usize,
    flag: &str,
) -> Result<&'a str, EvalArgsError> {
    match argv.get(*index) {
        Some(value) => {
            *index += 1;
            Ok(value.as_str())
        }
        None => Err(EvalArgsError::Message(format!("Missing value for {flag}"))),
    }
}

/// The per-trial poll deadline; `None` means unbounded.
///
/// The explicit `--timeout-minutes inf` (and `NaN`, which the argument
/// parser clamps away but a hand-built config could still carry) maps to an
/// unbounded wait, and any finite value too large to represent in a
/// [`Duration`] or to add to [`Instant::now`] degrades to unbounded as
/// well. Either way the deadline computation never panics, so the driver's
/// poll loop cannot leave a live session behind by crashing.
#[must_use]
pub fn trial_deadline(timeout_minutes: f64) -> Option<Instant> {
    if !timeout_minutes.is_finite() {
        return None;
    }
    Duration::try_from_secs_f64(timeout_minutes * 60.0)
        .ok()
        .and_then(|timeout| Instant::now().checked_add(timeout))
}

fn default_out_dir() -> String {
    let stamp = crate::session::manager::format_iso_now().replace([':', '.'], "-");
    format!("swarm-eval-reports/{stamp}")
}

/// Deterministic 3-digit secrets from a SHA-256 hash chain, so evals are
/// reproducible across runs. The digest advances on every child, and a
/// value already handed out is redrawn, so the secrets of one trial are
/// pairwise unique: children sharing a number would let a swapped or
/// merged aggregation still match the expected ANSWER.
#[must_use]
pub fn seeded_secrets(seed: i64, count: usize) -> Vec<u32> {
    let mut digest = Sha256::digest(format!("{seed}:{count}:0").as_bytes());
    let mut secrets = Vec::with_capacity(count);
    while secrets.len() < count {
        digest = Sha256::digest(digest);
        let value = 100 + (u32::from(digest[0]) * 256 + u32::from(digest[1])) % 900;
        // Redraw a handed-out value (order-checking the ANSWER requires
        // pairwise-unique secrets). Past 900 children the 3-digit space is
        // exhausted and the chain values pass through unchanged.
        if secrets.len() < 900 && secrets.contains(&value) {
            continue;
        }
        secrets.push(value);
    }
    secrets
}

/// The prompt one child receives: its secret, its arrival instruction, and
/// the exact REPORT line it must send back.
#[must_use]
pub fn build_child_prompt(index: usize, secret: u32, config: &SwarmEvalConfig) -> String {
    let wait_line = match config.pattern {
        ArrivalPattern::Spread => {
            let sleep_seconds = (index as f64) * config.gap_seconds;
            format!(
                "Before replying, run `await asyncio.sleep({sleep_seconds})` in the ipython tool, then continue."
            )
        }
        ArrivalPattern::Burst => "Reply immediately without waiting.".to_string(),
    };
    let filler = match config.message_size {
        MessageSize::Long => ", followed by 200 lines each containing only the word filler",
        MessageSize::Short => "",
    };
    [
        format!("Coordination eval child {}.", index + 1),
        format!("Your secret number is {secret}."),
        wait_line,
        format!("Reply to your parent with exactly: REPORT {secret}{filler}."),
        "Use `await agent_message.send(..., receiver_role='parent')` to reply, then end your turn. Do nothing else.".to_string(),
    ]
    .join("\n")
}

/// The orchestrator prompt: spawn every child verbatim, collect the REPORT
/// lines, then emit the single ANSWER line.
#[must_use]
pub fn build_orchestrator_prompt(config: &SwarmEvalConfig, size: usize, secrets: &[u32]) -> String {
    let child_blocks = secrets
        .iter()
        .enumerate()
        .map(|(index, &secret)| {
            let child = build_child_prompt(index, secret, config).replace('\n', "\n  ");
            format!(
                "- Child c{} prompt (copy verbatim):\n  \"\"\"\n  {child}\n  \"\"\"",
                index + 1
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    [
        format!("Coordination eval. You are the orchestrator of a {size}-subagent crew."),
        String::new(),
        "1. In one message, spawn every child below with `await rlm.spawn(...)` using the exact child prompt text given for it.".to_string(),
        "2. Each child replies to you with a REPORT line containing its secret number.".to_string(),
        format!("3. When all {size} children have replied, output exactly one line:"),
        "   ANSWER: <secret numbers of c1, c2, ... in child-name order, comma-separated>".to_string(),
        "Never emit the ANSWER line before every child has replied. End your turn only after emitting it.".to_string(),
        String::new(),
        "Child prompts:".to_string(),
        child_blocks,
    ]
    .join("\n")
}

/// Parse the final ANSWER line; `None` when absent or malformed.
///
/// Ordinary prose before the real ANSWER line can mention `answer:` (the
/// TS-era regex scanned forward past such mentions instead of pinning to
/// the first substring), so every case-insensitive occurrence is tried.
/// An occurrence wins only when its number list consumes the entire
/// remaining text: the ANSWER line must end the assistant's turn, so at
/// most one occurrence can win and trailing text never does.
#[must_use]
pub fn parse_answer_line(text: Option<&str>) -> Option<Vec<u64>> {
    let text = text?;
    let mut offset = 0;
    loop {
        let start = find_ascii_case_insensitive(text, "answer:", offset)?;
        if let Some(numbers) = parse_answer_suffix(&text[start + "answer:".len()..]) {
            return Some(numbers);
        }
        offset = start + 1;
    }
}

/// The strict ANSWER remainder: a comma-separated number list that consumes
/// the whole input.
fn parse_answer_suffix(rest: &str) -> Option<Vec<u64>> {
    let mut rest = rest.trim_start_matches(char::is_whitespace);
    let mut numbers = Vec::new();
    loop {
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        if digits.is_empty() {
            return None;
        }
        numbers.push(digits.parse::<u64>().ok()?);
        rest = rest[digits.len()..].trim_start_matches(char::is_whitespace);
        match rest.strip_prefix(',') {
            Some(after_comma) => rest = after_comma.trim_start_matches(char::is_whitespace),
            None => break,
        }
    }
    // Anything but whitespace after the last number means the ANSWER line is
    // malformed; parsing a prefix out of it would credit a wrong answer.
    rest.is_empty().then_some(numbers)
}

/// The first index at or after `from` where `needle` occurs, comparing
/// ASCII bytes case-insensitively.
fn find_ascii_case_insensitive(haystack: &str, needle: &str, from: usize) -> Option<usize> {
    let haystack = haystack.as_bytes();
    let needle = needle.as_bytes();
    if needle.is_empty() || haystack.len() < needle.len() || from > haystack.len() - needle.len() {
        return None;
    }
    (from..=haystack.len() - needle.len())
        .find(|&index| haystack[index..index + needle.len()].eq_ignore_ascii_case(needle))
}

/// One scored trial: its sweep coordinates, task outcome, the snapshot
/// counters, the defense lines, and the folded verdict.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SwarmEvalTrialResult {
    pub size: usize,
    pub message_size: MessageSize,
    pub pattern: ArrivalPattern,
    pub trial: usize,
    pub model: String,
    pub task_success: bool,
    pub instant_fail: Option<String>,
    pub arrivals: u64,
    pub arrivals_last5m: u64,
    pub model_steps: u64,
    pub ingestion_steps: u64,
    pub model_step_tokens: u64,
    pub ingestion_step_tokens: u64,
    pub estimated_agent_message_tokens: u64,
    pub context_tokens: Option<u64>,
    pub defense: MessagingDefenseLines,
    pub verdict: DefenseVerdict,
    pub seconds: f64,
}

/// Fold one trial's snapshot, task outcome, and any instant-fail reason into
/// a report row. A rate-limit error or a wrong/missing ANSWER fails the trial
/// instantly, regardless of the defense lines.
#[must_use]
pub fn trial_result_from_snapshot(
    config: &SwarmEvalConfig,
    size: usize,
    trial: usize,
    snapshot: &MessagingStatsSnapshot,
    task_success: bool,
    instant_fail: Option<String>,
    seconds: f64,
) -> SwarmEvalTrialResult {
    let defense = evaluate_messaging_defense_lines(snapshot, MessagingDefenseLineLimits::default());
    let verdict = if instant_fail.is_some() || !task_success {
        DefenseVerdict::Fail
    } else {
        defense.verdict
    };
    SwarmEvalTrialResult {
        size,
        message_size: config.message_size,
        pattern: config.pattern,
        trial,
        model: config.model.clone(),
        task_success,
        instant_fail,
        arrivals: snapshot.arrivals.total,
        arrivals_last5m: snapshot.arrivals.last5m,
        model_steps: snapshot.model_steps.total,
        ingestion_steps: snapshot.ingestion_steps.total,
        model_step_tokens: snapshot.model_steps.tokens,
        ingestion_step_tokens: snapshot.ingestion_steps.tokens,
        estimated_agent_message_tokens: snapshot.context.estimated_agent_message_tokens,
        context_tokens: snapshot.context.context_tokens,
        defense,
        verdict,
        seconds,
    }
}

/// The markdown summary: one row per trial plus the verdict summary.
#[must_use]
pub fn render_markdown_report(
    results: &[SwarmEvalTrialResult],
    config: &SwarmEvalConfig,
) -> String {
    let sizes = config
        .sizes
        .iter()
        .map(usize::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    let limits = MESSAGING_DEFENSE_LINE_LIMITS;
    let mut lines = vec![
        "# Swarm starvation eval report".to_string(),
        String::new(),
        format!("- model: {}", config.model),
        format!("- sizes: {sizes}"),
        format!(
            "- message size: {}  |  arrival pattern: {}  |  trials per config: {}",
            config.message_size.as_str(),
            config.pattern.as_str(),
            config.trials
        ),
        format!(
            "- defense lines: context <= {:.0}%, turns <= {:.0}%, cost <= {:.0}% (a trial with a rate-limit error or a wrong final answer fails instantly)",
            limits.context_share * 100.0,
            limits.turn_share * 100.0,
            limits.cost_share * 100.0
        ),
        String::new(),
        "| size | trial | arrivals | steps | ing. steps | ctx share | turn share | cost share | task | verdict |"
            .to_string(),
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |".to_string(),
    ];
    for row in results {
        let verdict = row
            .instant_fail
            .clone()
            .unwrap_or_else(|| row.verdict.as_str().to_string());
        lines.push(format!(
            "| {} | {} | {} | {} | {} | {} | {} | {} | {} | {verdict} |",
            row.size,
            row.trial,
            row.arrivals,
            row.model_steps,
            row.ingestion_steps,
            format_share(row.defense.context_share.value),
            format_share(row.defense.turn_share.value),
            format_share(row.defense.cost_share.value),
            if row.task_success { "ok" } else { "failed" },
        ));
    }
    let trial_ids = |verdict: DefenseVerdict| {
        results
            .iter()
            .filter(|row| row.verdict == verdict)
            .map(|row| format!("size {}/trial {}", row.size, row.trial))
            .collect::<Vec<_>>()
    };
    let failures = trial_ids(DefenseVerdict::Fail);
    let inconclusives = trial_ids(DefenseVerdict::Inconclusive);
    lines.push(String::new());
    lines.push("## Verdict".to_string());
    lines.push(String::new());
    if failures.is_empty() {
        if inconclusives.is_empty() {
            lines.push(format!(
                "All {} trials passed every defense line.",
                results.len()
            ));
        } else {
            // Inconclusive is its own class, never a silent pass: the
            // harness forbids presenting unmeasured trials as successes.
            lines.push(format!(
                "No trial failed a defense line, but {}/{} trials were inconclusive (a defense line was unmeasured): {}.",
                inconclusives.len(),
                results.len(),
                inconclusives.join(", ")
            ));
        }
    } else if inconclusives.is_empty() {
        lines.push(format!(
            "{}/{} trials failed: {}.",
            failures.len(),
            results.len(),
            failures.join(", ")
        ));
    } else {
        lines.push(format!(
            "{}/{} trials failed: {}. {} trials were inconclusive: {}.",
            failures.len(),
            results.len(),
            failures.join(", "),
            inconclusives.len(),
            inconclusives.join(", ")
        ));
    }
    lines.push(String::new());
    lines.join("\n")
}

fn format_share(value: Option<f64>) -> String {
    match value {
        Some(value) => format!("{:.1}%", value * 100.0),
        None => "n/a".to_string(),
    }
}

#[cfg(test)]
mod tests;
