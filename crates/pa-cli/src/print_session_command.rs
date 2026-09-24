//! Print-mode session slash-command execution: the print driver runs
//! `/compact`, `/refine`, `/goal`, and `/autonomous` prompts through the
//! pa-core session-command executor (the same seam the daemon worker
//! drives — no parallel implementation) and streams the TS print-json
//! shapes: the `session_action_update` phase frames around the durable
//! echo row, the per-command events (`compaction_start`/`compaction_end`,
//! the refinement rows plus `refine_complete`/`refine_failed`, the
//! `goal_update` publish, the `autonomous_status` row), the result rows,
//! and the settled queue frame.
//!
//! TS ground truth (probed against the installed binary over the shared
//! faux-provider harness): session commands never reach the model loop —
//! `AgentSession._normalizeSubmission` classifies them before admission,
//! so `_runPreTurnCompaction` never fires for them and the prompt's turn
//! never exists. A `/goal` start (or resume) schedules its continuation as
//! queued session input, which `promptAndWait` drains inside the same
//! wait — the driver admits it as the queued turn right after the
//! command's frames. A failed command rejects the prompt wait: the print
//! run prints the raw error to stderr, exits 1, and never runs later
//! prompts (TS `runPrintMode`'s catch).

use std::sync::Arc;

use pa_core::autonomous::AutonomousRuntimeState;
use pa_core::session_engine::engine::SessionEngine;
use pa_core::session_engine::session_commands::{
    execute_session_command, session_command_echo_row, SessionCommandExecution,
    SessionCommandParams,
};
use pa_core::session_engine::slash_commands::SessionSlashCommand;
use pa_types::ai::Model;
use serde_json::{json, Value};

use crate::print_goal::PrintGoalSurface;

/// `/compact <args>`: the args are the summary-focus instructions (the
/// `customInstructions` field of both compaction events).
fn compact_custom_instructions(command: &SessionSlashCommand) -> Option<String> {
    let args = command.args.trim();
    (!args.is_empty()).then(|| args.to_string())
}

/// The successful manual `compaction_end` event: the TS `CompactionResult`
/// wire shape (the boundary arm's event with `willRetry: false`).
fn manual_compaction_end_success(
    execution: &SessionCommandExecution,
    custom_instructions: Option<&str>,
) -> Value {
    let compaction = execution
        .compaction
        .as_ref()
        .expect("manual compaction_end success requires the compaction run");
    let result = json!({
        "summary": compaction.result.summary,
        "firstKeptEntryId": compaction.result.first_kept_entry_id,
        "tokensBefore": compaction.result.tokens_before,
        "details": compaction
            .entry
            .details
            .clone()
            .unwrap_or(json!({ "readFiles": [], "modifiedFiles": [] })),
    });
    let mut event = json!({
        "type": "compaction_end",
        "reason": "manual",
        "result": result,
        "aborted": false,
        "willRetry": false,
    });
    if let Some(instructions) = custom_instructions {
        event["customInstructions"] = json!(instructions);
    }
    event
}

/// The unsuccessful manual `compaction_end` event: a skip carries its
/// message with `warning` severity, a failure carries the
/// `Compaction failed: <message>` text with `error` severity (TS
/// `AgentSession.compact`'s catch arm).
fn manual_compaction_end_unsuccessful(
    message: &str,
    severity: &str,
    custom_instructions: Option<&str>,
) -> Value {
    let mut event = json!({
        "type": "compaction_end",
        "reason": "manual",
        "aborted": false,
        "willRetry": false,
        "errorMessage": message,
        "errorSeverity": severity,
    });
    if let Some(instructions) = custom_instructions {
        event["customInstructions"] = json!(instructions);
    }
    event
}

/// Execute one session command and stream its surface. The driver owns
/// the exit contract: the execution's `error` field carries the raw
/// failure (TS `promptAndWait` rejects with it — the print run prints it
/// to stderr, exits 1, and stops the prompt loop); the failure result row
/// is already durable and on the stream.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn execute_prompt_session_command(
    engine: &Arc<SessionEngine>,
    goal: &Arc<PrintGoalSurface>,
    model: &Model,
    api_key: Option<String>,
    global_harness_dir: std::path::PathBuf,
    autonomous: &Arc<tokio::sync::Mutex<AutonomousRuntimeState>>,
    command: &SessionSlashCommand,
) -> SessionCommandExecution {
    // TS `_executeSelectedSessionCommand`: the action's `preparing` and
    // `running` phase frames bookend the durable echo row, and `/compact`'s
    // `compaction_start` goes out before the summarizer runs.
    goal.emit_command_phase("preparing", &command.text).await;
    goal.emit_command_phase("running", &command.text).await;
    goal.emit_row_pair(&session_command_echo_row(command));
    let is_compact = command.name == "compact";
    let custom_instructions = compact_custom_instructions(command);
    if is_compact {
        let mut event = json!({ "type": "compaction_start", "reason": "manual" });
        if let Some(instructions) = &custom_instructions {
            event["customInstructions"] = json!(instructions);
        }
        goal.emit_stream_event(event);
    }
    // The refinement rows the executor's refine run appends (streamed in
    // TS emission order ahead of the `refine_complete` event).
    let entries_before = engine.session.entries().await.len();
    let execution = {
        let mut autonomous = autonomous.lock().await;
        let mut params = SessionCommandParams {
            model,
            api_key,
            global_harness_dir,
            autonomous: &mut autonomous,
        };
        execute_session_command(engine, &mut params, command).await
    };
    // `/compact`: the settled `compaction_end` precedes any failure result
    // row; a skip stays silent beyond the event (TS `CompactionSkippedError`
    // catch arm records nothing).
    if is_compact {
        if let Some(message) = execution
            .compaction
            .as_ref()
            .and_then(|compaction| compaction.ipython_state.as_ref())
        {
            goal.emit_row_pair(message);
        }
        let end = if execution.compaction.is_some() {
            manual_compaction_end_success(&execution, custom_instructions.as_deref())
        } else if let Some(skipped) = execution.compaction_skipped {
            manual_compaction_end_unsuccessful(skipped, "warning", custom_instructions.as_deref())
        } else {
            let error = execution
                .error
                .as_deref()
                .unwrap_or("compaction did not run");
            manual_compaction_end_unsuccessful(
                &format!("Compaction failed: {error}"),
                "error",
                custom_instructions.as_deref(),
            )
        };
        goal.emit_stream_event(end);
    }
    // `/refine`: the durable refinement rows stream as message pairs, then
    // `refine_complete` (or `refine_failed`), before the result row.
    if command.name == "refine" {
        for row in
            crate::print_boundary::TurnBoundary::refinement_rows_since(engine, entries_before).await
        {
            goal.emit_row_pair(&row);
        }
        if let Some(error) = &execution.refinement_failed {
            goal.emit_stream_event(json!({ "type": "refine_failed", "error": error }));
        } else if let Some(result) = &execution.refinement {
            goal.emit_stream_event(json!({
                "type": "refine_complete",
                "result": serde_json::to_value(result).unwrap_or(Value::Null),
            }));
        }
    }
    // `/goal`: the state change publishes unconditionally (TS
    // `_emitGoalUpdate` in the goal command arms), before the queue frame
    // of a scheduled continuation.
    if command.name == "goal" {
        goal.publish_goal_update_forced(engine).await;
    }
    // The queued continuation's preview frame rides while the command
    // action is still the active one (TS `_runOrQueueGoalContext` ->
    // `_emitQueueUpdate`).
    if let Some(continuation) = &execution.continuation_message {
        goal.emit_command_queue_hold(&command.text, continuation)
            .await;
    }
    // The executor's first row is the echo (already streamed); the rest —
    // result rows, the `autonomous_status` row, the failure row — follow
    // in order.
    for row in execution.messages.iter().skip(1) {
        goal.emit_row_pair(row);
    }
    if let Some(continuation) = &execution.continuation_message {
        goal.emit_command_queue_drain(continuation).await;
    } else {
        goal.emit_queue_idle().await;
    }
    execution
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::print_boundary::TurnBoundary;
    use crate::print_goal::PrintGoalSurface;
    use pa_core::session_engine::slash_commands::{parse_session_command, SlashCommandRegistry};
    use serde_json::json;

    /// One test at a time over the global faux registry (the same contract
    /// print_goal and print_boundary tests hold).
    static FAUX_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    type Frames = std::sync::Arc<std::sync::Mutex<Vec<Value>>>;

    fn capture_sink() -> (Frames, crate::print_goal::EventSink) {
        let frames: Frames = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink: crate::print_goal::EventSink = {
            let frames = Arc::clone(&frames);
            Arc::new(move |event: &Value| {
                frames.lock().unwrap().push(event.clone());
            })
        };
        (frames, sink)
    }

    /// The captured stream's compact event trace: one line per event with
    /// the kind and the distinguishing fields (the frame phases, the row
    /// types, the goal status, the compaction outcome).
    fn trace(frames: &Frames) -> Vec<String> {
        frames
            .lock()
            .unwrap()
            .iter()
            .map(|event| match event["type"].as_str().unwrap_or_default() {
                "session_action_update" => {
                    let actions = &event["actions"];
                    let active = &actions["active"];
                    if active.is_null() {
                        format!(
                            "sau:idle:{}",
                            actions["queuedCount"].as_u64().unwrap_or_default()
                        )
                    } else {
                        format!(
                            "sau:{}:{}",
                            active["kind"].as_str().unwrap_or_default(),
                            active["phase"].as_str().unwrap_or_default()
                        )
                    }
                }
                "message_start" | "message_end" => format!(
                    "{}:{}",
                    event["type"].as_str().unwrap(),
                    event["message"]["customType"].as_str().unwrap_or("message")
                ),
                "goal_update" => format!(
                    "goal_update:{}",
                    event["goal"]["status"].as_str().unwrap_or_default()
                ),
                "compaction_start" => "compaction_start:manual".to_string(),
                "compaction_end" => {
                    if event.get("result").is_some() {
                        "compaction_end:manual:success".to_string()
                    } else {
                        format!(
                            "compaction_end:manual:{}",
                            event["errorSeverity"].as_str().unwrap_or_default()
                        )
                    }
                }
                "refine_complete" => "refine_complete".to_string(),
                "refine_failed" => "refine_failed".to_string(),
                other => other.to_string(),
            })
            .collect()
    }

    /// One durable transcript row as (customType, text head).
    async fn custom_rows(engine: &Arc<SessionEngine>) -> Vec<(String, String)> {
        engine
            .session
            .entries()
            .await
            .into_iter()
            .filter_map(|entry| match entry {
                pa_types::session::FileEntry::CustomMessage { payload, .. } => Some((
                    payload.custom_type.clone(),
                    match &payload.content {
                        pa_types::ai::UserContent::Text(text) => text.clone(),
                        _ => String::new(),
                    },
                )),
                _ => None,
            })
            .collect()
    }

    struct Bed {
        engine: Arc<SessionEngine>,
        model: Model,
        goal: Arc<PrintGoalSurface>,
        autonomous: Arc<tokio::sync::Mutex<AutonomousRuntimeState>>,
        frames: Frames,
        harness_dir: std::path::PathBuf,
        /// Keeps the composed hook's autonomous arm alive for the bed's
        /// lifetime (the hook holds it weakly).
        _run: Arc<crate::headless_autonomous::HeadlessAutonomous>,
        _dir: tempfile::TempDir,
    }

    /// The faux engine bed (the print_goal test pattern): a persisted
    /// session over its own tempdir, the wired goal surface with a capture
    /// sink, and the default autonomous state.
    async fn bed(script: Value) -> Bed {
        bed_with_settings(script, json!({})).await
    }

    async fn bed_with_settings(script: Value, settings: Value) -> Bed {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::write(agent_dir.join("settings.json"), settings.to_string()).unwrap();
        let parsed = pa_ai::faux::script::parse_faux_script(&script).unwrap();
        let registration =
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                models: Some(vec![parsed.model.clone()]),
                ..Default::default()
            });
        registration.set_responses(parsed.responses);
        let model = registration.get_model();
        let stream_fn =
            pa_core::session_engine::provider_adapter::real_stream_fn(None, model.clone());
        let agent_model: pa_agent::types::Model =
            serde_json::from_value(serde_json::to_value(&model).unwrap()).unwrap();
        let session_manager = pa_core::session::manager::SessionManager::persisted(
            dir.path(),
            &dir.path().join("sessions"),
        );
        let engine = Arc::new(
            pa_core::session_engine::engine::create_session(
                pa_core::session_engine::engine::SessionEngineConfig {
                    cron_store: None,
                    telemetry: None,
                    cwd: dir.path().to_path_buf(),
                    agent_dir,
                    mcp_manager: None,
                    model: Some(agent_model),
                    thinking_level: None,
                    stream_fn: Some(stream_fn),
                    tools: Vec::new(),
                    custom_system_prompt: None,
                    prompt_guidelines: Vec::new(),
                    generic_mcp_servers: Vec::new(),
                    allow_recursion: None,
                    session_manager: Some(session_manager),
                    extra_host_handlers: None,
                    conversation_log_path: None,
                    additional_skill_paths: Vec::new(),
                    additional_prompt_paths: Vec::new(),
                    extra_builtin_skill_overrides: Vec::new(),
                    rlm_subagent_host: None,
                    rlm_depth: None,
                    model_info: Some(model.clone()),
                    cli_extension_sources: Vec::new(),
                    extension_tool_allow_list: None,
                    prewarm_ipython_kernel: None,
                    queued_goal_context_purge: None,
                    queued_steering_probe: None,
                    steering_mode: None,
                    follow_up_mode: None,
                },
            )
            .await
            .unwrap(),
        );
        let (frames, sink) = capture_sink();
        let goal = Arc::new(PrintGoalSurface::with_sink(true, sink));
        goal.seed_publish_baseline(&engine).await;
        let _accounting = goal.wire_accounting(&engine, engine.session.agent()).await;
        let run = Arc::new(crate::headless_autonomous::HeadlessAutonomous::disabled(
            dir.path(),
        ));
        crate::print_autonomous::wire_continuation_hook(
            &engine,
            engine.session.agent(),
            &model,
            &goal,
            &run,
        );
        let autonomous = run.state_handle();
        Bed {
            engine,
            model,
            goal,
            autonomous,
            frames,
            harness_dir: dir.path().join("harness"),
            _run: run,
            _dir: dir,
        }
    }

    fn command(text: &str) -> SessionSlashCommand {
        let registry = SlashCommandRegistry::builtin();
        parse_session_command(&registry, text).expect("the test text is a session command")
    }

    /// The driver's session-command branch (print_runtime's loop body).
    async fn run_command(bed: &Bed, text: &str) -> Option<String> {
        let execution = execute_prompt_session_command(
            &bed.engine,
            &bed.goal,
            &bed.model,
            None,
            bed.harness_dir.clone(),
            &bed.autonomous,
            &command(text),
        )
        .await;
        if execution.error.is_some() {
            return execution.error;
        }
        if let Some(continuation) = execution.continuation_message {
            let mut boundary = TurnBoundary::new(false);
            bed.goal
                .run_session_command_continuation(
                    &bed.engine,
                    &mut boundary,
                    &bed.model,
                    None,
                    bed.harness_dir.clone(),
                    &continuation,
                )
                .await
                .unwrap();
        }
        let mut boundary = TurnBoundary::new(false);
        bed.goal
            .drive_boundary(
                &bed.engine,
                &mut boundary,
                &bed.model,
                None,
                bed.harness_dir.clone(),
            )
            .await
            .unwrap();
        None
    }

    fn script(responses: Value) -> Value {
        json!({
            "engine": "faux",
            "modelId": "faux-1",
            "modelName": "Faux Model",
            "reasoning": false,
            "contextWindow": 128_000,
            "responses": responses,
        })
    }

    #[tokio::test]
    async fn goal_status_stream_matches_ts() {
        let _guard = FAUX_TEST_LOCK.lock().await;
        let test = bed(script(json!([]))).await;
        assert_eq!(run_command(&test, "/goal status").await, None);
        assert_eq!(
            trace(&test.frames),
            vec![
                "sau:session_command:preparing",
                "sau:session_command:running",
                "message_start:session_slash_command",
                "message_end:session_slash_command",
                "goal_update:idle",
                "message_start:session_slash_command_result",
                "message_end:session_slash_command_result",
                "sau:idle:0",
            ]
        );
        // The durable rows: the echo, then the "No active goal." result.
        assert_eq!(
            custom_rows(&test.engine).await,
            vec![
                (
                    "session_slash_command".to_string(),
                    "/goal status".to_string()
                ),
                (
                    "session_slash_command_result".to_string(),
                    "No active goal.".to_string()
                ),
            ]
        );
        // The live context carries the rows (TS pushes them onto the
        // agent state): the headless terminal selection sees the result.
        let state = test.engine.session.agent().state().await;
        let messages: Vec<pa_types::session::AgentMessage> = state
            .messages
            .iter()
            .filter_map(pa_core::session_engine::provider_adapter::json_round_trip)
            .collect();
        let result = pa_core::session_engine::headless::select_headless_terminal_result(&messages);
        let primary = result.primary.expect("the result row is the primary");
        assert_eq!(primary.stdout_text().as_deref(), Some("No active goal."));
    }

    #[tokio::test]
    async fn goal_start_admits_the_continuation() {
        let _guard = FAUX_TEST_LOCK.lock().await;
        let test = bed(script(json!([{"text": "goal turn reply"}]))).await;
        assert_eq!(run_command(&test, "/goal ship it").await, None);
        // The queued continuation ran to the faux queue's exhaustion and
        // the terminal error failed the goal.
        assert_eq!(
            trace(&test.frames),
            vec![
                "sau:session_command:preparing",
                "sau:session_command:running",
                "message_start:session_slash_command",
                "message_end:session_slash_command",
                "goal_update:active",
                "sau:session_command:running",
                "message_start:session_slash_command_result",
                "message_end:session_slash_command_result",
                "sau:idle:1",
                "sau:turn:preparing",
                "sau:turn:committing",
                "sau:turn:running",
                // The continuation turn's usage publish and the in-loop
                // mint's continuation bump (both `goal_update:active`),
                // then the terminal error fails the goal.
                "goal_update:active",
                "goal_update:active",
                "goal_update:error",
                "sau:idle:0",
            ]
        );
        let rows = custom_rows(&test.engine).await;
        assert_eq!(rows[0].0, "session_slash_command");
        assert_eq!(rows[1].1, "Goal active: ship it");
        assert!(rows.iter().any(|row| row.0 == "goal_context"));
    }

    #[tokio::test]
    async fn compact_skip_warns_without_a_row() {
        let _guard = FAUX_TEST_LOCK.lock().await;
        let test = bed(script(json!([]))).await;
        assert_eq!(run_command(&test, "/compact").await, None);
        // A skip records nothing beyond the echo (TS CompactionSkippedError
        // catch arm) and the end event carries the warning.
        assert_eq!(
            trace(&test.frames),
            vec![
                "sau:session_command:preparing",
                "sau:session_command:running",
                "message_start:session_slash_command",
                "message_end:session_slash_command",
                "compaction_start:manual",
                "compaction_end:manual:warning",
                "sau:idle:0",
            ]
        );
        assert_eq!(
            custom_rows(&test.engine).await,
            vec![("session_slash_command".to_string(), "/compact".to_string())]
        );
    }

    #[tokio::test]
    async fn failed_command_carries_the_raw_error() {
        let _guard = FAUX_TEST_LOCK.lock().await;
        // Two long seed turns consume the queue; the compactable session's
        // /compact then fails its summarizer call.
        let settings = json!({
            "compaction": {"enabled": true, "reserveTokens": 1, "keepRecentTokens": 10}
        });
        let test =
            bed_with_settings(script(json!([{"text": "r1"}, {"text": "r2"}])), settings).await;
        let long_seed = "seed turn one ".to_string() + &"x".repeat(15000);
        test.engine
            .session
            .prompt(&long_seed, Default::default())
            .await
            .unwrap();
        test.engine.session.agent().wait_for_idle().await;
        let long_seed_two = "seed turn two ".to_string() + &"x".repeat(15000);
        test.engine
            .session
            .prompt(&long_seed_two, Default::default())
            .await
            .unwrap();
        test.engine.session.agent().wait_for_idle().await;
        let error = run_command(&test, "/compact focus").await;
        assert_eq!(
            error.as_deref(),
            Some("Summarization failed: No more faux responses queued")
        );
        // The failure result row is durable ahead of the exit.
        let rows = custom_rows(&test.engine).await;
        assert_eq!(rows.last().unwrap().0, "session_slash_command_result");
        assert!(rows.last().unwrap().1.starts_with("Command failed:"));
    }
}
