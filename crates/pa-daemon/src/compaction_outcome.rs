//! The unsuccessful-compaction disclosure (TS `_endCompactionUnsuccessfully`
//! -> `_persistCompactionOutcome`): an automatic skip or failure records the
//! durable `compaction_outcome` custom row, broadcasts it, and emits the
//! settled `compaction_end`; manual `/compact` reports on the event only.

use serde_json::Value;

use crate::agent_engine::AgentSessionEngine;
use crate::compaction::compaction_end_unsuccessful;
use crate::engine::EngineEvent;
use crate::session_commands::custom_message_value;
use pa_core::session_engine::messages::{CompactionOutcomeKind, CompactionOutcomeReason};

impl AgentSessionEngine {
    /// Record and broadcast one unsuccessful-compaction outcome, then emit the
    /// `compaction_end` event (TS `_endCompactionUnsuccessfully`: the row's message
    /// pair goes out first). A skip carries `errorMessage`/`warning`, an automatic
    /// failure no `errorSeverity`, a cancel `aborted` with no message.
    pub(crate) fn emit_unsuccessful_compaction(
        &self,
        reason: CompactionOutcomeReason,
        outcome: CompactionOutcomeKind,
        message: &str,
        custom_instructions: Option<&str>,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) -> bool {
        // The durable row + live-context insertion (TS
        // `_persistCompactionOutcome`).
        let row = {
            let guard = self.session.blocking_lock();
            guard.as_deref().map(|engine| {
                self.runtime.block_on(async {
                    engine
                        .session
                        .record_compaction_outcome(reason, outcome, message)
                        .await
                })
            })
        };
        if let Some(row) = row {
            // A failed durable row skips only the custom-message emit; the terminal
            // `compaction_end` below still fires so clients never stay pending.
            match row {
                Ok(row) => {
                    if !emit(EngineEvent::CustomMessage(custom_message_value(&row))) {
                        return false;
                    }
                }
                Err(error) => {
                    eprintln!("pa-daemon: compaction outcome persistence failed: {error:#}");
                }
            }
        }
        let (aborted, error_message, error_severity) = match outcome {
            CompactionOutcomeKind::Skipped => (false, Some(message), Some("warning")),
            // Automatic failures carry no `errorSeverity` on the wire (TS
            // `_endCompactionUnsuccessfully` passes none for the auto arms).
            CompactionOutcomeKind::Failed => (false, Some(message), None),
            // Aborts are user-initiated; the event carries no error message
            // (the durable row owns the disclosure).
            CompactionOutcomeKind::Cancelled => (true, None, None),
        };
        let event = compaction_end_unsuccessful(
            reason.wire(),
            aborted,
            error_message,
            error_severity,
            custom_instructions,
        );
        emit(EngineEvent::Compaction {
            entry: Value::Null,
            event,
        })
    }
}
