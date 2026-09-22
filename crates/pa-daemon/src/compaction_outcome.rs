//! The unsuccessful-compaction disclosure (TS `_endCompactionUnsuccessfully`
//! -> `_persistCompactionOutcome`): when an automatic compaction at a turn
//! boundary skips or fails, the daemon records the durable
//! `compaction_outcome` custom row (the session seam), broadcasts it as a
//! `message_start`/`message_end` pair, and emits the settled `compaction_end`
//! event carrying the same message. Manual `/compact` stays excluded (TS
//! `compact()` reports its outcome on the event only and throws to the
//! caller).

use serde_json::Value;

use crate::agent_engine::AgentSessionEngine;
use crate::compaction::compaction_end_unsuccessful;
use crate::engine::EngineEvent;
use crate::session_commands::custom_message_value;
use pa_core::session_engine::messages::{CompactionOutcomeKind, CompactionOutcomeReason};

impl AgentSessionEngine {
    /// Record and broadcast one unsuccessful-compaction outcome, then emit
    /// the `compaction_end` event (TS `_endCompactionUnsuccessfully`: the
    /// disclosure row's message pair goes out first, the end event second).
    /// The event's shape derives from the outcome kind exactly like the TS
    /// call sites: a skip carries `errorMessage` with `warning` severity, an
    /// automatic failure carries it with no `errorSeverity`, and a cancel
    /// carries `aborted` with no message (aborts are user-initiated; the
    /// durable row owns the disclosure). `custom_instructions` rides the
    /// event when the run carried any (TS threads the consumed pending
    /// request's instructions). Both events carry `willRetry: false`.
    /// Returns `false` when the emitter asked to stop.
    pub(crate) fn emit_unsuccessful_compaction(
        &self,
        reason: CompactionOutcomeReason,
        outcome: CompactionOutcomeKind,
        message: &str,
        custom_instructions: Option<&str>,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) -> bool {
        // The durable row + live-context insertion (TS
        // `_persistCompactionOutcome`); both arms that reach here ran
        // against a built session, so the guard is structural.
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
            if !emit(EngineEvent::CustomMessage(custom_message_value(&row))) {
                return false;
            }
        }
        let (aborted, error_message, error_severity) = match outcome {
            CompactionOutcomeKind::Skipped => (false, Some(message), Some("warning")),
            // Automatic failures carry no `errorSeverity` on the wire (TS
            // `_endCompactionUnsuccessfully` passes none for the auto arms).
            CompactionOutcomeKind::Failed => (false, Some(message), None),
            // Aborts are user-initiated; the event carries no error message
            // (TS `_endCompactionUnsuccessfully`'s `{ aborted: true }`; the
            // durable row owns the disclosure).
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
