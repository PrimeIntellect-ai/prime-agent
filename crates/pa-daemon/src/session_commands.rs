//! Daemon-side session slash-command execution: bridge the pa-core
//! executor to the worker engine contract. `run_prompt` parses the four
//! session commands before admission — they never reach the model loop —
//! executes them against the engine's session, and translates the durable
//! rows into engine events (the worker persists and broadcasts them).
//!
//! `/compact` runs with the full TS event pair: the echo row and
//! `compaction_start` go out before the summarizer runs, the settled
//! `compaction_end` (result, or the skip/failure message with its
//! severity) after — so attached clients always see the compaction
//! start and its outcome (TS `_executeSelectedSessionCommand` order,
//! then `AgentSession.compact`'s events).
//!
//! This is the spin fix for session commands: previously a session command
//! admitted through `run_turn` would wait for an `AgentStart` that never
//! arrives. Parsing before admission keeps the wait loop reachable only
//! for real turns.

use pa_core::session_engine::session_commands::{
    session_command_echo_row, session_command_failure_row, SessionCommandExecution,
};
use pa_core::session_engine::slash_commands::{
    parse_session_command, SessionSlashCommand, SlashCommandRegistry,
};
use pa_types::session::AgentMessage;

use crate::agent_engine::AgentSessionEngine;
use crate::engine::EngineEvent;

/// Run one session command and emit its durable rows. `None` means the
/// emitter asked to stop (abort): the host must not emit a `Done`.
pub(crate) fn run_session_command(
    engine: &AgentSessionEngine,
    command: SessionSlashCommand,
    emit: &mut dyn FnMut(EngineEvent) -> bool,
) -> Option<SessionCommandExecution> {
    let is_compact = command.name == "compact";
    // The durable echo row goes out before execution (TS
    // `_executeSelectedSessionCommand` records the attempted command
    // before the queue runs it).
    if !emit(EngineEvent::CustomMessage(custom_message_value(
        &session_command_echo_row(&command),
    ))) {
        return None;
    }
    if is_compact {
        let custom_instructions = compact_custom_instructions(&command);
        let start =
            crate::compaction::compaction_start_event("manual", custom_instructions.as_deref());
        if !emit(EngineEvent::CompactionStart { event: start }) {
            return None;
        }
    }
    let execution = match engine.execute_session_command(&command) {
        Ok(execution) => execution,
        // Pre-execution failures (model resolution, session build) still
        // record the attempted command as a failure result row (the echo
        // row above already went out).
        Err(error) => {
            let error = format!("{error:#}");
            let execution = SessionCommandExecution {
                messages: vec![session_command_failure_row(&command, &error)],
                compaction: None,
                compaction_skipped: None,
                continuation_message: None,
                error: Some(error),
                refinement: None,
                refinement_failed: None,
            };
            if !emit_compact_end(&command, &execution, emit) {
                return None;
            }
            for message in &execution.messages {
                if !emit(EngineEvent::CustomMessage(custom_message_value(message))) {
                    return None;
                }
            }
            return Some(execution);
        }
    };
    // The post-compaction kernel notice goes out between the compaction
    // start and its settled end (TS `_syncKernelStateAfterCompaction` runs
    // inside `_performCompaction`, so the `message_start`/`message_end`
    // pair precedes `compaction_end` on the wire); the worker persists
    // the row with the event.
    if let Some(message) = execution
        .compaction
        .as_ref()
        .and_then(|compaction| compaction.ipython_state.as_ref())
    {
        if !emit(EngineEvent::CustomMessage(custom_message_value(message))) {
            return None;
        }
    }
    // The settled `compaction_end` precedes any failure result row (TS
    // `compact()` emits the event before the queued-command catch arm
    // appends `Command failed: ...`).
    if is_compact && !emit_compact_end(&command, &execution, emit) {
        return None;
    }
    // `/autonomous` (either flip): the previous run's owed continuations
    // clear (TS `_handleAutonomousSlashCommand`: the off branch drops the
    // queued and held turns, the on branch resets the run state; the
    // durable status row follows with the new state).
    if command.name == "autonomous" {
        engine.clear_autonomous_continuations();
    }
    // The executor's first row is the echo (already emitted); the rest of
    // the durable rows follow in order.
    for message in execution.messages.iter().skip(1) {
        if !emit(EngineEvent::CustomMessage(custom_message_value(message))) {
            return None;
        }
    }
    Some(execution)
}

/// `/compact <args>`: the args are the summary-focus instructions.
fn compact_custom_instructions(command: &SessionSlashCommand) -> Option<String> {
    let args = command.args.trim();
    (!args.is_empty()).then(|| args.to_string())
}

/// The settled `compaction_end` event for one `/compact` execution (TS
/// `AgentSession.compact`'s end event): success carries the client-facing
/// `CompactionResult`; a skip carries its message with warning severity; a
/// failure carries `Compaction failed: <message>` with error severity.
fn emit_compact_end(
    command: &SessionSlashCommand,
    execution: &SessionCommandExecution,
    emit: &mut dyn FnMut(EngineEvent) -> bool,
) -> bool {
    let custom_instructions = compact_custom_instructions(command);
    let (entry, event) = if let Some(compaction) = &execution.compaction {
        let entry = serde_json::to_value(&compaction.entry).unwrap_or(serde_json::Value::Null);
        // The client-facing result is the TS `CompactionResult` wire shape
        // (`_performCompaction`'s return, details included).
        let result =
            crate::compaction::compaction_result_value(&compaction.result, &compaction.entry);
        (
            entry,
            crate::compaction::compaction_end_success(
                "manual",
                &result,
                false,
                custom_instructions.as_deref(),
            ),
        )
    } else if let Some(skipped) = execution.compaction_skipped {
        (
            serde_json::Value::Null,
            crate::compaction::compaction_end_unsuccessful(
                "manual",
                false,
                Some(skipped),
                Some("warning"),
                custom_instructions.as_deref(),
            ),
        )
    } else {
        // A failure (or a pre-execution error): `execution.error` carries
        // the raw message; the TS event prefixes `Compaction failed: `.
        let error = execution
            .error
            .as_deref()
            .unwrap_or("compaction did not run");
        (
            serde_json::Value::Null,
            crate::compaction::compaction_end_unsuccessful(
                "manual",
                false,
                Some(&format!("Compaction failed: {error}")),
                Some("error"),
                custom_instructions.as_deref(),
            ),
        )
    };
    emit(EngineEvent::Compaction { entry, event })
}

/// Parse a session command out of a prompt, if it is one.
pub(crate) fn parse_prompt_session_command(text: &str) -> Option<SessionSlashCommand> {
    let registry = SlashCommandRegistry::builtin();
    parse_session_command(&registry, text)
}

/// One durable row in its wire message form (`role: "custom"`): the shape
/// `message_start`/`message_end` pairs carry and TS sessions keep in
/// `agent.state.messages`.
pub(crate) fn custom_message_value(
    message: &pa_types::session::CustomMessage,
) -> serde_json::Value {
    serde_json::to_value(AgentMessage::Custom(message.clone())).unwrap_or(serde_json::Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_command_prompt_parsing() {
        let command = parse_prompt_session_command("/goal status").unwrap();
        assert_eq!(command.name, "goal");
        assert_eq!(command.args, "status");
        assert!(parse_prompt_session_command("plain prompt").is_none());
        // Client commands are not session commands.
        assert!(parse_prompt_session_command("/model").is_none());
    }

    #[test]
    fn custom_rows_serialize_with_custom_role() {
        let command = parse_prompt_session_command("/compact focus").unwrap();
        let row = session_command_failure_row(&command, "boom");
        let value = custom_message_value(&row);
        assert_eq!(value["role"], "custom");
        assert_eq!(value["customType"], "session_slash_command_result");
        assert_eq!(value["content"], "Command failed: boom");
        assert_eq!(value["details"]["success"], false);
    }
}
