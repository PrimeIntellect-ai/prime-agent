//! The worker's compaction runs.
//!
//! Port of the TS daemon-mode compaction surface: the `compact` /
//! `abort_compaction` handlers, the `compaction_start`/`compaction_end`
//! `session_event` frames with their exact TS shapes, the `isCompacting`
//! state flag, and the durable compaction entry the worker appends to the
//! session store. The summarizer call itself is one
//! [`SessionEngine::run_compaction`]; this module owns everything around it
//! (abort registry, events, store persistence, state flags).

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::engine::{CompactionOutcome, CompactionRequest, SessionEngine};
use crate::protocol::DaemonOutbound;
use crate::worker::{EventPump, OutboundFrame, SessionCore};
use pa_agent::abort::AbortController;
use pa_core::session_engine::messages::{CompactionOutcomeKind, CompactionOutcomeReason};

/// The worker's compaction machinery: the live-run abort slot plus the
/// compaction flow. One slot per session, replaced by each new run, mirroring
/// the TS `_compactionAbortController`.
pub(crate) struct CompactionManager {
    engine: Arc<dyn SessionEngine>,
    events: Arc<EventPump>,
    core: Arc<Mutex<SessionCore>>,
    active_session_id: String,
    agent_dir: std::path::PathBuf,
    abort: Mutex<Option<Arc<AbortController>>>,
}

impl CompactionManager {
    pub(crate) fn new(
        engine: Arc<dyn SessionEngine>,
        events: Arc<EventPump>,
        core: Arc<Mutex<SessionCore>>,
        active_session_id: String,
        agent_dir: std::path::PathBuf,
    ) -> Self {
        CompactionManager {
            engine,
            events,
            core,
            active_session_id,
            agent_dir,
            abort: Mutex::new(None),
        }
    }

    /// `abort_compaction` (TS `abortCompaction`): abort the live
    /// compaction — the manual run's controller (TS
    /// `_compactionAbortController`) and the automatic threshold /
    /// requested run (TS `_autoCompactionAbortController`, owned by the
    /// engine). Succeeds whether or not a run is in flight; the TS handler
    /// always replies success.
    pub(crate) fn abort(&self) {
        let controller = self.abort.lock().unwrap().clone();
        if let Some(controller) = controller {
            controller.abort();
        }
        self.engine.abort_auto_compaction();
    }

    /// Run one compaction (`compact` command): emits the TS event pair,
    /// keeps `isCompacting` set for the run, and appends the durable
    /// compaction entry on success. The caller translates the outcome into
    /// the command response.
    pub(crate) async fn run(
        &self,
        custom_instructions: Option<String>,
        idle_notify: &tokio::sync::Notify,
    ) -> CompactionOutcome {
        // A compaction interrupts the running turn first (TS `compact()`
        // aborts the agent before summarizing): request the abort and wait
        // for the turn to settle.
        self.wait_for_turn_end(idle_notify).await;

        let controller = Arc::new(AbortController::new());
        let signal = controller.signal();
        {
            // Each run replaces the live slot, mirroring the TS
            // `_compactionAbortController` assignment; aborts hit the newest
            // run, and only its own run clears the slot.
            *self.abort.lock().unwrap() = Some(Arc::clone(&controller));
        }
        {
            let mut core = self.core.lock().unwrap();
            core.compacting = true;
        }
        let start = compaction_start_event("manual", custom_instructions.as_deref());
        let _ = self.emit_session_event(start);
        pa_core::session_engine::compaction_trace::trace(
            "manual.start_emitted",
            serde_json::Value::Null,
        );

        let engine = Arc::clone(&self.engine);
        let request = CompactionRequest {
            custom_instructions: custom_instructions.clone(),
        };
        let run_signal = signal.clone();
        let outcome = {
            let engine = Arc::clone(&engine);
            tokio::task::spawn_blocking(move || engine.run_compaction(request, &run_signal))
                .await
                .unwrap_or_else(|join_error| CompactionOutcome::Failed {
                    error: format!("compaction run failed: {join_error}"),
                })
        };

        {
            let mut core = self.core.lock().unwrap();
            core.compacting = false;
        }
        if let CompactionOutcome::Compacted { run } = &outcome {
            pa_core::session_engine::compaction_trace::trace(
                "manual.compact_returned",
                serde_json::Value::Null,
            );
            let persist_started = std::time::Instant::now();
            self.persist_compaction(run, custom_instructions.as_deref());
            pa_core::session_engine::compaction_trace::trace(
                "manual.compaction_persisted",
                serde_json::json!({
                    "micros": persist_started.elapsed().as_micros(),
                }),
            );
            // The post-compaction kernel notice (TS
            // `_syncKernelStateAfterCompaction` runs inside
            // `_performCompaction`, so its `message_start`/`message_end`
            // pair precedes `compaction_end` on the wire): persist the
            // durable row and broadcast the pair.
            if let Some(message) = &run.ipython_state {
                self.persist_and_emit_ipython_state(message);
            }
        }
        let end = compaction_end_event(&outcome, custom_instructions.as_deref());
        let _ = self.emit_session_event(end);
        pa_core::session_engine::compaction_trace::trace(
            "manual.end_emitted",
            serde_json::Value::Null,
        );
        {
            let mut slot = self.abort.lock().unwrap();
            if slot
                .as_ref()
                .is_some_and(|live| Arc::ptr_eq(live, &controller))
            {
                *slot = None;
            }
        }
        outcome
    }

    /// `set_auto_compaction`: update the connection-state flag. The
    /// settings write that persists the toggle lives in the
    /// `set_auto_compaction` handler (`setting_switches`).
    pub(crate) fn set_auto_compaction(&self, enabled: bool) {
        let mut core = self.core.lock().unwrap();
        core.auto_compaction_enabled = enabled;
    }

    /// Wait until the running turn (if any) has settled.
    async fn wait_for_turn_end(&self, idle_notify: &tokio::sync::Notify) {
        loop {
            let busy = {
                let mut core = self.core.lock().unwrap();
                if core.busy {
                    core.abort_requested = true;
                    // TS `compact()` detaches from agent events
                    // (`_disconnectFromAgent()`) before the abort, so the
                    // interrupted turn's aborted assistant row never
                    // reaches the wire or the session file on the compact
                    // path — the gate's aborted-row exception stays closed
                    // for this turn.
                    core.suppress_aborted_row = true;
                    true
                } else {
                    false
                }
            };
            if !busy {
                break;
            }
            // The parked flag gates the turn's events; the engine abort
            // cancels the in-flight provider fetch immediately (TS
            // `compact()` -> `abort()` -> `requestAbort()` ->
            // `agent.abort()`), so the interrupt does not wait out a
            // pending provider response and the aborted turn settles on
            // its zero-usage aborted message.
            self.engine.abort_in_flight_turn();
            // The turn runner notifies when the queue drains; the timeout is
            // a backstop so a missed notification cannot hang a compact.
            let _ =
                tokio::time::timeout(std::time::Duration::from_millis(50), idle_notify.notified())
                    .await;
        }
        // The interrupted turn settled (its row swallowed exactly like the
        // TS compact path); the suppression owns only that drain window.
        self.core.lock().unwrap().suppress_aborted_row = false;
    }

    /// Append the durable compaction entry to the worker's session store
    /// (TS `appendCompaction`). A real engine hands over its full durable
    /// record, so `details`, `fromHook`, `customInstructions`, `usage`, and
    /// the `harnessDigest` snapshot persist verbatim; a scripted engine (a
    /// test seam with no real entry) builds the record from the scripted
    /// wire result. An empty `firstKeptEntryId` (the scripted default)
    /// keeps from the first branch entry, so the compacted read retains
    /// the transcript.
    fn persist_compaction(
        &self,
        run: &crate::engine::CompactionRun,
        custom_instructions: Option<&str>,
    ) {
        let result = &run.result;
        let mut core = self.core.lock().unwrap();
        let cwd = core.cwd.clone();
        let Some(store) = core.store.as_mut() else {
            return;
        };
        let mut fields = if run.entry.is_object() {
            run.entry.clone()
        } else {
            let mut fields = json!({
                "summary": result.get("summary").cloned().unwrap_or_default(),
                // The TS `CompactionEntry` field order (the JSON map preserves
                // insertion order; the value is re-pinned in place below).
                "firstKeptEntryId": "",
                "tokensBefore": result.get("tokensBefore").cloned().unwrap_or(json!(0)),
                "details": result.get("details").cloned().unwrap_or_else(|| json!({
                    "readFiles": [], "modifiedFiles": [],
                })),
                "fromHook": false,
            });
            if let Some(custom_instructions) = custom_instructions {
                fields["customInstructions"] = json!(custom_instructions);
            }
            if let Some(usage) = &run.usage {
                fields["usage"] = usage.clone();
            }
            fields
        };
        // The engine's id references its in-memory entry list, a separate
        // id space from the session file: re-pin the boundary to the
        // durable cut so the file read retains the kept tail (TS: one
        // store, ids match by construction). An unreadable durable cut
        // keeps the engine id rather than dropping the boundary entirely.
        let first_kept_entry_id = fields
            .get("firstKeptEntryId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let first_kept_entry_id = if first_kept_entry_id.is_empty() {
            store
                .branch()
                .iter()
                .find(|entry| entry.type_ == "message")
                .map(|entry| entry.id.clone())
                .unwrap_or_default()
        } else {
            let keep_recent = pa_core::settings::SettingsManager::create(&cwd, &self.agent_dir)
                .settings()
                .compaction
                .clone()
                .unwrap_or_default()
                .keep_recent_tokens
                .unwrap_or(pa_core::session_engine::compaction::DEFAULT_KEEP_RECENT_TOKENS);
            store
                .durable_first_kept_entry_id(keep_recent)
                .unwrap_or(first_kept_entry_id)
        };
        fields["firstKeptEntryId"] = json!(first_kept_entry_id);
        let _ = store.persist_entry("compaction", fields);
    }

    /// Persist the post-compaction `ipython_state` row to the session store
    /// and broadcast its `message_start`/`message_end` pair (TS
    /// `appendCustomMessageEntry` + the `_emit` pair inside
    /// `_performCompaction`). The engine's in-memory session already holds
    /// the row; the worker's store owns the durable file.
    fn persist_and_emit_ipython_state(&self, message: &Value) {
        {
            let mut core = self.core.lock().unwrap();
            if let Some(store) = core.store.as_mut() {
                let _ = store.persist_entry(
                    "custom_message",
                    json!({
                        "customType": message.get("customType").cloned().unwrap_or(Value::Null),
                        "content": message.get("content").cloned().unwrap_or(Value::Null),
                        "display": message.get("display").cloned().unwrap_or(Value::Bool(true)),
                        "details": message.get("details").cloned().unwrap_or(Value::Null),
                    }),
                );
            }
        }
        for event_type in ["message_start", "message_end"] {
            let _ = self.emit_session_event(json!({
                "type": event_type,
                "message": message,
            }));
        }
    }

    /// Sequence and broadcast one compaction `session_event` frame.
    fn emit_session_event(&self, event: Value) -> serde_json::Result<()> {
        let mut core = self.core.lock().unwrap();
        let sequence = core.last_event_sequence + 1;
        core.last_event_sequence = sequence;
        let meta = crate::protocol::create_daemon_event_meta(
            &self.active_session_id,
            sequence,
            None,
            Some(&core.generation),
        );
        let outbound = DaemonOutbound::SessionEvent {
            active_session_id: self.active_session_id.clone(),
            event,
            meta: Some(meta),
            rest: Default::default(),
        };
        let payload = serde_json::to_vec(&outbound)?;
        drop(core);
        self.events.send(OutboundFrame::session_event(payload));
        Ok(())
    }
}

/// The `compaction_start` event payload (TS `AgentSessionEvent`). Shared by
/// every compaction surface: the `compact` RPC, the `/compact` session
/// command, and the automatic threshold compaction all emit the same shape
/// with their own `reason` (`manual` / `threshold`; TS
/// `CompactionOutcomeReason`).
pub(crate) fn compaction_start_event(reason: &str, custom_instructions: Option<&str>) -> Value {
    let mut event = json!({ "type": "compaction_start", "reason": reason });
    if let Some(custom_instructions) = custom_instructions {
        event["customInstructions"] = json!(custom_instructions);
    }
    event
}

/// The client-facing `CompactionResult` of a successful compaction (TS
/// `_performCompaction`'s return, the `data` of the `compact` response and
/// the `result` of the settled `compaction_end` event): summary,
/// firstKeptEntryId, tokensBefore, and the durable entry's file-op
/// `details` verbatim. `usage` never rides the wire result (TS keeps it on
/// the persisted entry), and a run whose entry carries no `details` drops
/// the key exactly like the TS extension arm's `undefined` under JSON
/// serialization.
pub(crate) fn compaction_result_value(
    result: &pa_core::session_engine::compaction_exec::CompactionResult,
    entry: &pa_types::session::CompactionEntry,
) -> Value {
    let mut value = json!({
        "summary": result.summary,
        "firstKeptEntryId": result.first_kept_entry_id,
        "tokensBefore": result.tokens_before,
    });
    if let Some(details) = &entry.details {
        value["details"] = details.clone();
    }
    value
}

/// The `compaction_end` event payload of a successful compaction (TS
/// `AgentSessionEvent`): the client-facing `CompactionResult` plus whether
/// the session retries the failed turn on the compacted context (the
/// overflow compact-and-retry arm is the only `willRetry: true` source).
/// `reason` is the TS `CompactionOutcomeReason` (`manual` for user-initiated
/// runs, `requested` for model-requested boundary compactions).
pub(crate) fn compaction_end_success(
    reason: &str,
    result: &Value,
    will_retry: bool,
    custom_instructions: Option<&str>,
) -> Value {
    let mut event = json!({
        "type": "compaction_end",
        "reason": reason,
        "result": result,
        "aborted": false,
        "willRetry": will_retry,
    });
    if let Some(custom_instructions) = custom_instructions {
        event["customInstructions"] = json!(custom_instructions);
    }
    event
}

/// The `compaction_end` event payload of an unsuccessful compaction (TS
/// `_endCompactionUnsuccessfully`'s event shape): `aborted` marks a
/// cancelled run; a skip or failure carries its `errorMessage` with the
/// matching `errorSeverity`.
pub(crate) fn compaction_end_unsuccessful(
    reason: &str,
    aborted: bool,
    error_message: Option<&str>,
    error_severity: Option<&str>,
    custom_instructions: Option<&str>,
) -> Value {
    let mut event = json!({
        "type": "compaction_end",
        "reason": reason,
        "aborted": aborted,
        "willRetry": false,
    });
    if let Some(error_message) = error_message {
        event["errorMessage"] = json!(error_message);
    }
    if let Some(error_severity) = error_severity {
        event["errorSeverity"] = json!(error_severity);
    }
    if let Some(custom_instructions) = custom_instructions {
        event["customInstructions"] = json!(custom_instructions);
    }
    event
}

/// The durable disclosure of a compaction the supervisor declared aborted
/// (the abort supervision's create replay): the same `compaction_outcome`
/// row the worker's own auto-abort arms persist — `cancelled` with the
/// run's reason, in the wire custom-message field shape the store
/// persists — plus the declaration's timestamp. A manual run has no row
/// (TS `compact()`'s abort arm writes none), and any other reason never
/// invents one. The declaration timestamp is the row's stable identity:
/// it rides the create payload as `declaredAt` and stamps the persisted
/// entry, so a replacement that died between persisting the disclosure
/// and the supervisor consuming the record replays it again and the
/// create handler recognizes its own row instead of duplicating it.
pub(crate) struct InterruptedCompactionDisclosure {
    pub(crate) row: Value,
    pub(crate) declared_at: String,
}

/// Rebuild the [`InterruptedCompactionDisclosure`] from the create
/// payload's `interruptedCompaction` record, or `None` for a run that
/// persists no row.
pub(crate) fn interrupted_compaction_disclosure(
    payload: &Value,
) -> Option<InterruptedCompactionDisclosure> {
    let record = payload.get("interruptedCompaction")?;
    let reason = match record.get("reason").and_then(Value::as_str) {
        Some("threshold") => CompactionOutcomeReason::Threshold,
        Some("overflow") => CompactionOutcomeReason::Overflow,
        Some("requested") => CompactionOutcomeReason::Requested,
        _ => return None,
    };
    let declared_at = record
        .get("declaredAt")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(crate::util::now_iso);
    let message = crate::session_commands::custom_message_value(
        &pa_core::session_engine::messages::create_compaction_outcome_message(
            "Compaction cancelled",
            reason,
            CompactionOutcomeKind::Cancelled,
        ),
    );
    let row = json!({
        "customType": message.get("customType").cloned().unwrap_or(Value::Null),
        "content": message.get("content").cloned().unwrap_or(Value::Null),
        "display": message.get("display").cloned().unwrap_or(Value::Bool(true)),
        "details": message.get("details").cloned().unwrap_or(Value::Null),
    });
    Some(InterruptedCompactionDisclosure { row, declared_at })
}

/// The `compaction_end` event payload (TS `AgentSessionEvent`), per outcome:
/// success carries `result`; a skip carries `errorMessage` with warning
/// severity; a failure carries `Compaction failed: <message>` with error
/// severity; an abort carries `aborted` with error severity and no message.
fn compaction_end_event(outcome: &CompactionOutcome, custom_instructions: Option<&str>) -> Value {
    match outcome {
        CompactionOutcome::Compacted { run } => {
            compaction_end_success("manual", &run.result, false, custom_instructions)
        }
        CompactionOutcome::Skipped { message } => compaction_end_unsuccessful(
            "manual",
            false,
            Some(message),
            Some("warning"),
            custom_instructions,
        ),
        CompactionOutcome::Failed { error } => compaction_end_unsuccessful(
            "manual",
            false,
            Some(&format!("Compaction failed: {error}")),
            Some("error"),
            custom_instructions,
        ),
        CompactionOutcome::Aborted => {
            compaction_end_unsuccessful("manual", true, None, Some("error"), custom_instructions)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compaction_result_value_mirrors_the_ts_datakeys() {
        let result = pa_core::session_engine::compaction_exec::CompactionResult {
            summary: "the story so far".to_string(),
            first_kept_entry_id: "abcd1234".to_string(),
            tokens_before: 1234,
            usage: Some(pa_types::ai::Usage::default()),
        };
        let entry = pa_types::session::CompactionEntry {
            summary: result.summary.clone(),
            first_kept_entry_id: result.first_kept_entry_id.clone(),
            tokens_before: result.tokens_before,
            details: Some(json!({ "readFiles": ["a.rs"], "modifiedFiles": ["b.rs"] })),
            from_hook: Some(false),
            custom_instructions: None,
            usage: result.usage,
            harness_digest: None,
        };
        // The TS `compact` response dataKeys (the live golden,
        // `tests/goldens/compaction-live-ts.json`): summary,
        // firstKeptEntryId, tokensBefore, details — with the entry's
        // `details` verbatim and the summarizer usage never on the wire.
        assert_eq!(
            compaction_result_value(&result, &entry),
            json!({
                "summary": "the story so far",
                "firstKeptEntryId": "abcd1234",
                "tokensBefore": 1234,
                "details": { "readFiles": ["a.rs"], "modifiedFiles": ["b.rs"] },
            })
        );
        // Byte order: the TS `compact` response dataKeys are summary,
        // firstKeptEntryId, tokensBefore, details (the JSON map preserves
        // insertion order), and the `details` block keeps the TS
        // readFiles-first literal order.
        assert_eq!(
            serde_json::to_string(&compaction_result_value(&result, &entry)).unwrap(),
            "{\"summary\":\"the story so far\",\"firstKeptEntryId\":\"abcd1234\",\"tokensBefore\":1234,\"details\":{\"readFiles\":[\"a.rs\"],\"modifiedFiles\":[\"b.rs\"]}}"
        );
        // A run whose entry carries no details drops the key, like the TS
        // extension arm's `undefined` under JSON serialization.
        let bare = pa_types::session::CompactionEntry {
            details: None,
            ..entry
        };
        assert_eq!(
            compaction_result_value(&result, &bare),
            json!({
                "summary": "the story so far",
                "firstKeptEntryId": "abcd1234",
                "tokensBefore": 1234,
            })
        );
    }

    #[test]
    fn event_shapes_match_ts() {
        let run = crate::engine::CompactionRun {
            result: json!({
                "summary": "the story so far",
                "firstKeptEntryId": "abcd1234",
                "tokensBefore": 1234,
                "details": { "readFiles": ["a.rs"], "modifiedFiles": [] },
            }),
            usage: None,
            entry: Value::Null,
            ipython_state: None,
        };
        assert_eq!(
            compaction_start_event("manual", Some("focus on the goal")),
            json!({
                "type": "compaction_start",
                "reason": "manual",
                "customInstructions": "focus on the goal",
            })
        );
        assert_eq!(
            compaction_start_event("manual", None),
            json!({ "type": "compaction_start", "reason": "manual" })
        );
        assert_eq!(
            compaction_end_event(
                &CompactionOutcome::Compacted { run: Box::new(run) },
                Some("focus")
            ),
            json!({
                "type": "compaction_end",
                "reason": "manual",
                "result": {
                    "summary": "the story so far",
                    "firstKeptEntryId": "abcd1234",
                    "tokensBefore": 1234,
                    "details": { "readFiles": ["a.rs"], "modifiedFiles": [] },
                },
                "aborted": false,
                "willRetry": false,
                "customInstructions": "focus",
            })
        );
        assert_eq!(
            compaction_end_event(
                &CompactionOutcome::Skipped {
                    message: "Session is too short to compact — try again once it grows"
                        .to_string(),
                },
                None,
            ),
            json!({
                "type": "compaction_end",
                "reason": "manual",
                "aborted": false,
                "willRetry": false,
                "errorMessage": "Session is too short to compact — try again once it grows",
                "errorSeverity": "warning",
            })
        );
        assert_eq!(
            compaction_end_event(&CompactionOutcome::Aborted, None),
            json!({
                "type": "compaction_end",
                "reason": "manual",
                "aborted": true,
                "willRetry": false,
                "errorSeverity": "error",
            })
        );
        assert_eq!(
            compaction_end_event(
                &CompactionOutcome::Failed {
                    error: "Summarization failed".to_string(),
                },
                None,
            ),
            json!({
                "type": "compaction_end",
                "reason": "manual",
                "aborted": false,
                "willRetry": false,
                "errorMessage": "Compaction failed: Summarization failed",
                "errorSeverity": "error",
            })
        );
    }

    /// The replay disclosure mirrors the worker's own auto-abort row and
    /// carries the declaration's identity; a manual run (or any reason
    /// outside the auto arms) persists nothing, like TS `compact()`'s
    /// abort arm.
    #[test]
    fn interrupted_disclosure_is_the_auto_abort_row_stamped_with_the_declaration() {
        let disclosure = interrupted_compaction_disclosure(&json!({
            "interruptedCompaction": {
                "reason": "threshold",
                "sessionFile": "/sessions/a.jsonl",
                "declaredAt": "2026-09-23T06:00:00Z",
            }
        }))
        .expect("a threshold run discloses");
        assert_eq!(
            disclosure.row,
            json!({
                "customType": "compaction_outcome",
                "content": "Compaction cancelled",
                "display": true,
                "details": { "reason": "threshold", "outcome": "cancelled" },
            })
        );
        assert_eq!(disclosure.declared_at, "2026-09-23T06:00:00Z");

        for reason in ["manual", "unknown"] {
            assert!(
                interrupted_compaction_disclosure(&json!({
                    "interruptedCompaction": { "reason": reason, "declaredAt": "2026-09-23T06:00:00Z" }
                }))
                .is_none(),
                "{reason} persists no row"
            );
        }
    }
}
