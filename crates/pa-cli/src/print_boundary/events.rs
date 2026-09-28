//! The boundary renderers: the TS wire-event surface of the print
//! runtime's turn boundary — the `compaction_start`/`compaction_end`
//! event builders and the json-mode emission methods, the child cut
//! of the `print_boundary` facade (text mode rides the durable rows).

use super::*;

/// The `compaction_start` event (TS `_runAutoCompaction`): the reason plus
/// the consumed request's instructions when it carried any.
pub(super) fn compaction_start_event(reason: &str, custom_instructions: Option<&str>) -> Value {
    let mut event = json!({ "type": "compaction_start", "reason": reason });
    if let Some(instructions) = custom_instructions {
        event["customInstructions"] = json!(instructions);
    }
    event
}

/// The successful `compaction_end` event (TS `_runAutoCompaction`): the TS
/// `CompactionResult` wire shape plus `willRetry` (true only for the
/// overflow compact-and-retry arm).
pub(super) fn compaction_end_success_event(
    reason: &str,
    run: &CompactRun,
    will_retry: bool,
    custom_instructions: Option<&str>,
) -> Value {
    // The wire result is the TS `CompactionResult` shape: the client-facing
    // summary fields plus the persisted entry's `details` (the TS default
    // when the entry carried none).
    let result = json!({
        "summary": run.result.summary,
        "firstKeptEntryId": run.result.first_kept_entry_id,
        "tokensBefore": run.result.tokens_before,
        "details": run
            .entry
            .details
            .clone()
            .unwrap_or(json!({ "readFiles": [], "modifiedFiles": [] })),
    });
    let mut event = json!({
        "type": "compaction_end",
        "reason": reason,
        "result": result,
        "aborted": false,
        "willRetry": will_retry,
    });
    if let Some(instructions) = custom_instructions {
        event["customInstructions"] = json!(instructions);
    }
    event
}

impl TurnBoundary {
    /// The post-compaction kernel notice (TS
    /// `_syncKernelStateAfterCompaction` runs inside `_performCompaction`):
    /// json mode streams its `message_start`/`message_end` pair before the
    /// `compaction_end` event, exactly like the TS session's `_emit` pair;
    /// text mode keeps the row as durable bookkeeping (`display: false`).
    pub(super) fn emit_ipython_state_row(&self, run: &CompactRun) {
        if !self.json_mode {
            return;
        }
        let Some(row) = &run.ipython_state else {
            return;
        };
        let value = crate::headless_autonomous::custom_row_wire_value(row);
        for event_type in ["message_start", "message_end"] {
            (self.sink)(&json!({ "type": event_type, "message": value }));
        }
    }

    /// The unsuccessful-compaction surface (TS `_endCompactionUnsuccessfully`
    /// -> `_persistCompactionOutcome`): record the durable
    /// `compaction_outcome` row (json mode also broadcasts its
    /// `message_start`/`message_end` pair on the event stream, exactly like
    /// the TS session's row push), then emit the `compaction_end` event. A
    /// skip carries `errorSeverity: "warning"`; automatic failures carry no
    /// `errorSeverity` (TS passes none). The text-mode surface rides the
    /// durable rows through the headless terminal result.
    pub(super) async fn end_unsuccessfully(
        &self,
        engine: &SessionEngine,
        reason: CompactionOutcomeReason,
        outcome: CompactionOutcomeKind,
        message: &str,
        custom_instructions: Option<&str>,
    ) {
        let row = engine
            .session
            .record_compaction_outcome(reason, outcome, message)
            .await;
        // A failed durable row skips only the row events; the terminal
        // `compaction_end` below still fires so a streamed
        // `compaction_start` never stays pending.
        match row {
            Ok(row) => {
                if self.json_mode {
                    let value = crate::headless_autonomous::custom_row_wire_value(&row);
                    for event_type in ["message_start", "message_end"] {
                        (self.sink)(&json!({ "type": event_type, "message": value }));
                    }
                }
            }
            Err(error) => {
                self.emit_json(json!({ "type": "error", "message": error.to_string() }));
            }
        }
        let mut event = json!({
            "type": "compaction_end",
            "reason": reason.wire(),
            "aborted": false,
            "willRetry": false,
            "errorMessage": message,
        });
        if outcome == CompactionOutcomeKind::Skipped {
            event["errorSeverity"] = json!("warning");
        }
        if let Some(instructions) = custom_instructions {
            event["customInstructions"] = json!(instructions);
        }
        self.emit_json(event);
    }

    /// Stream one session event in json mode (text mode stays quiet here).
    pub(super) fn emit_json(&self, event: Value) {
        if self.json_mode {
            (self.sink)(&event);
        }
    }
}
