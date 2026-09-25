//! Session slash-command execution: the daemon-side behavior behind
//! `/compact`, `/refine`, `/goal`, and `/autonomous`. Port of
//! agent-session.ts `_executeSelectedSessionCommand` (the durable echo
//! row) and `_executeQueuedSessionCommand` (the per-command executors and
//! their result rows).
//!
//! The host runtime owns persistence of what this returns: the messages
//! (echo, result, status rows), the compaction record, and any follow-up
//! prompt to admit as a turn (goal start/resume). Errors carry the exact
//! TS message; the host renders the `Command failed: ...` result row.

use std::sync::Arc;

use pa_types::session::CustomMessage;

use crate::autonomous::{
    autonomous_status, set_autonomous_enabled, set_autonomous_limits, AutonomousRuntimeState,
};
use crate::goals::{create_goal_context_message, GoalContextKind, GoalStatus};
use crate::slash_command_args::{
    format_autonomous_status, parse_autonomous_command, parse_goal_command, AutonomousCommand,
    GoalCommand,
};

use super::compact_session::CompactOutcome;
use super::engine::SessionEngine;
use super::goal_driver::GoalDriver;
use super::messages::{
    SESSION_SLASH_COMMAND_CUSTOM_TYPE, SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE,
};
use super::refine::{RefineOptions, RefinementSource};
use super::slash_commands::{parse_refine_command_options, SessionSlashCommand};

pub use crate::autonomous::AUTONOMOUS_STATUS_CUSTOM_TYPE;

/// Inputs the host runtime supplies to one execution.
pub struct SessionCommandParams<'a> {
    /// The resolved model for summarizer/refiner calls.
    pub model: &'a pa_types::ai::Model,
    /// Resolved API key (None falls back to provider resolution).
    pub api_key: Option<String>,
    /// The global harness directory (refinement history).
    pub global_harness_dir: std::path::PathBuf,
    /// The session's autonomous runtime state, held by the host runtime.
    pub autonomous: &'a mut AutonomousRuntimeState,
}

/// A completed compaction to persist: the session record plus the
/// client-facing result.
#[derive(Debug, Clone)]
pub struct CompactionExecution {
    pub entry: pa_types::session::CompactionEntry,
    pub result: super::compaction_exec::CompactionResult,
    /// The post-compaction `ipython_state` notice row when a kernel was
    /// running (already durable; hosts broadcast its `message_start` /
    /// `message_end` pair).
    pub ipython_state: Option<CustomMessage>,
}

/// What one execution produced.
#[derive(Debug, Default)]
pub struct SessionCommandExecution {
    /// Durable custom messages in order: the command echo, then any result
    /// or status rows.
    pub messages: Vec<CustomMessage>,
    /// A compaction that ran (no result row: the TS `/compact` outcome is
    /// the compaction record itself).
    pub compaction: Option<CompactionExecution>,
    /// A compaction skipped (TS `CompactionSkippedError`): the message the
    /// wire `compaction_end` event carries so attached surfaces can warn
    /// (the durable transcript itself records nothing, matching the TS
    /// queued-command catch arm that returns silently).
    pub compaction_skipped: Option<&'static str>,
    /// An injected custom row the follow-up turn runs on (goal
    /// start/resume): the loop admission carries the row itself, so the
    /// transcript holds ONE representation of the turn (the custom row),
    /// like TS's prepared-turn primary record. It is NOT part of
    /// `messages` — the loop's `message_end` persists it once the turn
    /// is admitted.
    pub continuation_message: Option<CustomMessage>,
    /// The command failed: the TS error message. The failure result row
    /// (`Command failed: ...`) is already appended to `messages`.
    pub error: Option<String>,
    /// A refinement run's structured outcome (host transports surface it as
    /// a completion event; the result row in `messages` stays display-only).
    pub refinement: Option<crate::refinement::RefinementResult>,
    /// A refinement run failed: the raw run error (option-parse failures
    /// leave this `None`; they are command failures, not refinement events).
    pub refinement_failed: Option<String>,
}

impl SessionCommandExecution {
    fn push_message(&mut self, message: CustomMessage) {
        self.messages.push(message);
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

/// The durable command echo row (`session_slash_command`). Public for the
/// host transports that emit the echo before execution (TS
/// `_executeSelectedSessionCommand` records it before the command runs).
pub fn session_command_echo_row(command: &SessionSlashCommand) -> CustomMessage {
    CustomMessage {
        custom_type: SESSION_SLASH_COMMAND_CUSTOM_TYPE.to_string(),
        content: pa_types::ai::UserContent::Text(command.text.clone()),
        display: true,
        details: Some(command_details(command)),
        timestamp: now_millis(),
        rest: Default::default(),
    }
}

/// The command description carried by echo and result rows.
fn command_details(command: &SessionSlashCommand) -> serde_json::Value {
    serde_json::json!({
        "command": {
            "name": command.name,
            "args": command.args,
            "text": command.text,
        }
    })
}

/// The failure result row for a command that failed before or during
/// execution: hosts append it so the transcript still records the attempt
/// (TS `_executeQueuedSessionCommand` catch arm).
pub fn session_command_failure_row(command: &SessionSlashCommand, error: &str) -> CustomMessage {
    slash_command_result(
        command,
        format!("Command failed: {error}"),
        false,
        "error",
        Some(error),
        true,
    )
}

/// The durable result row (`session_slash_command_result`).
fn slash_command_result(
    command: &SessionSlashCommand,
    content: String,
    success: bool,
    severity: &'static str,
    error: Option<&str>,
    display: bool,
) -> CustomMessage {
    let mut details = command_details(command);
    details["success"] = serde_json::json!(success);
    details["severity"] = serde_json::json!(severity);
    if let Some(error) = error {
        details["error"] = serde_json::json!(error);
    }
    CustomMessage {
        custom_type: SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE.to_string(),
        content: pa_types::ai::UserContent::Text(content),
        display,
        details: Some(details),
        timestamp: now_millis(),
        rest: Default::default(),
    }
}

/// The goal status line (`Goal <status>: <objective>` / `No active goal.`).
fn goal_status_text(state: &crate::goals::GoalState) -> String {
    match &state.objective {
        Some(objective) if state.status != GoalStatus::Idle => {
            format!("Goal {}: {objective}", state.status.slug())
        }
        _ => "No active goal.".to_string(),
    }
}

/// Execute one session command against the engine's session. The echo row
/// is durable whether the command succeeds or fails (TS
/// `_executeSelectedSessionCommand` appends it before execution); a failure
/// appends the `Command failed: ...` result row and reports `error`.
pub async fn execute_session_command(
    engine: &SessionEngine,
    params: &mut SessionCommandParams<'_>,
    command: &SessionSlashCommand,
) -> SessionCommandExecution {
    let mut execution = SessionCommandExecution::default();
    // TS `_appendDurableSessionCommandMessage` records the attempted
    // command BEFORE the queue runs it, so the command's own work (the
    // compaction branch, the refinement snapshot) sees the echo row in the
    // session branch.
    let echo = session_command_echo_row(command);
    execution.push_message(echo.clone());
    if let Err(error) = persist_rows(engine, std::iter::once(&echo)).await {
        execution.error = Some(error);
        return execution;
    }
    // Telemetry adoption seam: builtin session commands carry their usage
    // event from the single dispatch point (canonical name only).
    if let Some(telemetry) = &engine.telemetry {
        telemetry.note_command_used(command.name);
    }
    let result = match command.name {
        "compact" => execute_compact(engine, params, command, &mut execution).await,
        "refine" => execute_refine(engine, params, command, &mut execution).await,
        "goal" => execute_goal(engine, command, &mut execution).await,
        "autonomous" => execute_autonomous(params, command, &mut execution),
        other => Err(format!("Unknown session command: {other}")),
    };
    if let Err(message) = result {
        execution.push_message(slash_command_result(
            command,
            format!("Command failed: {message}"),
            false,
            "error",
            Some(&message),
            true,
        ));
        execution.error = Some(message);
    }
    // The echo row is already durable (persisted ahead of the command);
    // the result and status rows follow in order.
    if let Err(error) = persist_rows(engine, execution.messages.iter().skip(1)).await {
        execution.error = Some(error);
    }
    sync_live_context(engine).await;
    execution
}

/// The live agent context mirrors the durable rows (TS
/// `_appendDurableSessionCommandMessage` pushes each row onto
/// `agent.state.messages`, so the next admitted turn's request and every
/// state snapshot carry them). The post-execution rebuild is idempotent
/// for the compaction and refinement paths, which rebuild mid-execution.
async fn sync_live_context(engine: &SessionEngine) {
    let session = engine.session.session_handle().clone();
    let rebuilt = {
        let session = session.lock().await;
        session.active_context().messages
    };
    // The raw session messages (not the LLM view): custom rows keep their
    // wire identity in the live context, like TS's state push.
    let loop_messages: Vec<pa_agent::types::AgentMessage> = rebuilt
        .iter()
        .filter_map(super::session_message_to_loop)
        .collect();
    engine.session.agent().set_messages(loop_messages).await;
}

/// `/compact`: summarize and cut, or skip silently (TS `CompactionSkippedError`).
async fn execute_compact(
    engine: &SessionEngine,
    params: &SessionCommandParams<'_>,
    command: &SessionSlashCommand,
    execution: &mut SessionCommandExecution,
) -> Result<(), String> {
    let instructions = (!command.args.is_empty()).then_some(command.args.as_str());
    let outcome = engine
        .session
        .compact(instructions, params.model, params.api_key.clone(), None)
        .await
        .map_err(|error| format!("{error:#}"))?;
    match outcome {
        CompactOutcome::Skipped(message) => {
            execution.compaction_skipped = Some(message);
        }
        CompactOutcome::Ran(run) => {
            if let Some(telemetry) = &engine.telemetry {
                telemetry.note_compaction();
            }
            execution.compaction = Some(CompactionExecution {
                entry: run.entry,
                result: run.result,
                ipython_state: run.ipython_state,
            });
        }
    }
    Ok(())
}

/// `/refine`: run the refinement and record the applied-edit count.
async fn execute_refine(
    engine: &SessionEngine,
    params: &mut SessionCommandParams<'_>,
    command: &SessionSlashCommand,
    execution: &mut SessionCommandExecution,
) -> Result<(), String> {
    let options = parse_refine_command_options(&command.args)?;
    let refine_options = RefineOptions {
        global: options.global,
        instructions: options.instructions,
        rollback_id: options.rollback_id,
    };
    let result = match engine
        .session
        .refine(
            &refine_options,
            RefinementSource::User,
            params.model,
            params.api_key.take(),
            params.global_harness_dir.clone(),
        )
        .await
    {
        Ok(result) => result,
        Err(error) => {
            // The refinement run itself failed: a host transport surfaces
            // this as a refinement event, distinct from the command failure.
            execution.refinement_failed = Some(format!("{error:#}"));
            return Err(format!("{error:#}"));
        }
    };
    execution.refinement = Some(result.clone());
    let applied = result
        .applied_edits
        .iter()
        .filter(|edit| edit.applied)
        .count();
    let content = format!(
        "Refined continual harness state: {applied} edit{} applied.",
        if applied == 1 { "" } else { "s" }
    );
    // The refinement outcome message renders the details; the result row is
    // durable but not displayed (TS `displayResult = false`).
    execution.push_message(slash_command_result(
        command, content, true, "info", None, false,
    ));
    Ok(())
}

/// `/goal`: status, clear, pause, resume, and start (which schedules the
/// first continuation turn). The status result row precedes the durable
/// goal-context row of the scheduled turn.
async fn execute_goal(
    engine: &SessionEngine,
    command: &SessionSlashCommand,
    execution: &mut SessionCommandExecution,
) -> Result<(), String> {
    let goal = parse_goal_command(&command.args)?;
    let driver: Arc<tokio::sync::Mutex<GoalDriver>> = engine.goal_driver.clone();
    let session = engine.session.session_handle().clone();
    let mut context_message: Option<CustomMessage> = None;
    {
        let mut driver = driver.lock().await;
        let mut session = session.lock().await;
        // The clear's reply reflects the action, not the post-clear
        // state (the operator's 2026-09-25 bug report): TS answers
        // "No active goal." either way, which reads as the command
        // having failed on the goal it just cleared. A clear that
        // removed a goal record answers "Goal cleared."; the
        // nothing-to-clear case keeps the plain status text.
        let mut cleared_goal = false;
        match goal {
            GoalCommand::Status => {}
            // TS `_clearGoal`/`_pauseGoal`/`_startGoal` route through
            // `_clearQueuedGoalContexts` first: a minted continuation
            // waiting in the queue never runs behind the state change.
            GoalCommand::Clear => {
                engine.purge_queued_goal_contexts();
                cleared_goal =
                    driver.state().objective.is_some() && driver.state().status != GoalStatus::Idle;
                driver
                    .clear(&mut session)
                    .map_err(|error| format!("{error:#}"))?;
            }
            GoalCommand::Pause => {
                engine.purge_queued_goal_contexts();
                driver
                    .pause(&mut session, "Paused by user")
                    .map_err(|error| format!("{error:#}"))?;
            }
            GoalCommand::Resume => {
                context_message = driver
                    .resume(&mut session)
                    .map_err(|error| format!("{error:#}"))?;
            }
            GoalCommand::Start {
                objective,
                token_budget,
            } => {
                engine.purge_queued_goal_contexts();
                let state = driver
                    .start(&mut session, &objective, token_budget)
                    .map_err(|error| format!("{error:#}"))?;
                context_message = Some(
                    create_goal_context_message(&state, GoalContextKind::Continuation)
                        .map_err(|error| format!("{error:#}"))?,
                );
            }
        }
        let status_text = if cleared_goal {
            "Goal cleared.".to_string()
        } else {
            goal_status_text(driver.state())
        };
        execution.push_message(slash_command_result(
            command,
            status_text,
            true,
            "info",
            None,
            true,
        ));
    }
    // TS `_runOrQueueGoalContext`: the goal-context row becomes the
    // turn's primary record (an injected custom row), never an early
    // durable row — the loop admission appends it once.
    execution.continuation_message = context_message;
    Ok(())
}

/// `/autonomous`: status, on (with budget flags), off. Emits the durable
/// `autonomous_status` row (TS `_emitAutonomousStatus`).
fn execute_autonomous(
    params: &mut SessionCommandParams<'_>,
    command: &SessionSlashCommand,
    execution: &mut SessionCommandExecution,
) -> Result<(), String> {
    let parsed = parse_autonomous_command(&command.args)?;
    match parsed {
        AutonomousCommand::Status => {}
        AutonomousCommand::On { config } => {
            set_autonomous_enabled(params.autonomous, true);
            set_autonomous_limits(params.autonomous, &config);
        }
        AutonomousCommand::Off => set_autonomous_enabled(params.autonomous, false),
    }
    let status = autonomous_status(params.autonomous);
    execution.push_message(CustomMessage {
        custom_type: AUTONOMOUS_STATUS_CUSTOM_TYPE.to_string(),
        content: pa_types::ai::UserContent::Text(format_autonomous_status(&status)),
        display: true,
        details: serde_json::to_value(&status).ok(),
        timestamp: now_millis(),
        rest: Default::default(),
    });
    Ok(())
}

/// The rows are durable in the session's own entry chain: the live
/// context rebuild and a later `/compact` see the same rows the host
/// runtime persists (TS pushes each row onto `agent.state.messages`).
async fn persist_rows<'a>(
    engine: &SessionEngine,
    messages: impl Iterator<Item = &'a CustomMessage>,
) -> Result<(), String> {
    let session = engine.session.session_handle().clone();
    let mut session = session.lock().await;
    for message in messages {
        session
            .append_custom_message(
                &message.custom_type,
                message.content.clone(),
                message.display,
                message.details.clone(),
            )
            .map_err(|error| error.to_string())?;
    }
    session.flush_now().map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::goals::{empty_goal_state, GoalState, GoalStatus};
    use pa_types::ai::UserContent;

    fn command(name: &'static str, args: &str) -> SessionSlashCommand {
        let text = if args.is_empty() {
            format!("/{name}")
        } else {
            format!("/{name} {args}")
        };
        SessionSlashCommand {
            name,
            args: args.to_string(),
            text,
        }
    }

    fn message_text(message: &CustomMessage) -> String {
        message.content.text()
    }

    #[test]
    fn echo_row_shape_matches_ts() {
        let echo = session_command_echo_row(&command("compact", "focus on tests"));
        assert_eq!(echo.custom_type, "session_slash_command");
        assert_eq!(message_text(&echo), "/compact focus on tests");
        assert!(echo.display);
        let details = echo.details.unwrap();
        assert_eq!(
            details["command"],
            serde_json::json!({
                "name": "compact",
                "args": "focus on tests",
                "text": "/compact focus on tests",
            })
        );
    }

    #[test]
    fn result_row_shape_matches_ts() {
        let result = slash_command_result(
            &command("goal", "ship it"),
            "Goal active: ship it".to_string(),
            true,
            "info",
            None,
            true,
        );
        assert_eq!(result.custom_type, "session_slash_command_result");
        assert_eq!(message_text(&result), "Goal active: ship it");
        let details = result.details.unwrap();
        assert_eq!(details["success"], serde_json::json!(true));
        assert_eq!(details["severity"], serde_json::json!("info"));

        let failed = slash_command_result(
            &command("refine", ""),
            "Command failed: boom".to_string(),
            false,
            "error",
            Some("boom"),
            true,
        );
        assert_eq!(failed.details.unwrap()["error"], serde_json::json!("boom"));
    }

    #[test]
    fn goal_status_text_matches_ts() {
        let mut state = empty_goal_state();
        assert_eq!(goal_status_text(&state), "No active goal.");
        state.objective = Some("ship it".to_string());
        state.status = GoalStatus::Active;
        assert_eq!(goal_status_text(&state), "Goal active: ship it");
        state.status = GoalStatus::Paused;
        assert_eq!(goal_status_text(&state), "Goal paused: ship it");
        state.status = GoalStatus::BudgetLimited;
        assert_eq!(goal_status_text(&state), "Goal budget_limited: ship it");
    }

    #[tokio::test]
    async fn autonomous_status_row_emitted() {
        // A scripted engine is not needed: the executor's autonomous branch
        // touches only the runtime state.
        let mut autonomous = crate::autonomous::create_autonomous_runtime_state(None, None);
        let mut execution = SessionCommandExecution::default();
        execute_autonomous(
            &mut SessionCommandParams {
                model: &scripted_model(),
                api_key: None,
                global_harness_dir: std::path::PathBuf::from("/tmp"),
                autonomous: &mut autonomous,
            },
            &command("autonomous", "on --max-turns 5"),
            &mut execution,
        )
        .unwrap();
        assert!(autonomous.enabled);
        assert_eq!(autonomous.limits.max_turns, 5);
        assert_eq!(execution.messages.len(), 1);
        let status = &execution.messages[0];
        assert_eq!(status.custom_type, "autonomous_status");
        assert!(message_text(status).starts_with("[autonomous-status: on]"));
        assert!(matches!(status.content, UserContent::Text(_)));
    }

    fn scripted_model() -> pa_types::ai::Model {
        serde_json::from_value(serde_json::json!({
            "id": "m", "name": "m", "api": "openai-completions", "provider": "test",
            "baseUrl": "http://localhost", "reasoning": false, "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 1000, "maxTokens": 100
        }))
        .unwrap()
    }

    #[test]
    fn goal_state_slugs() {
        let state = GoalState {
            status: GoalStatus::Complete,
            ..empty_goal_state()
        };
        assert_eq!(state.status.slug(), "complete");
    }
}
