//! The compact-trigger auto-refine machine: the TS
//! `_compactAutoRefinePending` flow of the print runtime's turn
//! boundary — the review gates, the durable-row surface, the
//! requested-refinement streaming, and the disposal drain — the child
//! cut of the `print_boundary` facade.

use super::*;

/// Wall-clock milliseconds (the review-cooldown stamps, TS `Date.now()`).
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

/// Where the compact-trigger auto-refine surfaces (TS: the serialized
/// checkpoint runs mid-run, so its events stream; the disposal drain runs
/// after the print client tore its subscription down, so its events land
/// nowhere — only the durable rows persist).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RefineSurface {
    /// The serialized checkpoint at a turn boundary (`shouldStopAfterTurn`).
    Checkpoint,
    /// The session disposal drain (TS `dispose`: best-effort, silent).
    Dispose,
}

impl TurnBoundary {
    /// TS `_assistantTurnsSinceAutoRefine` (the `message_end` increments): the
    /// settled non-error, non-aborted assistant turns appended since the
    /// last boundary call, added to the counter the review prompt's trigger
    /// line carries.
    pub(super) async fn count_settled_turns(&mut self, engine: &SessionEngine) {
        let Some(baseline) = self.entry_baseline else {
            return;
        };
        let entries = engine.session.entries().await;
        let settled = entries
            .iter()
            .skip(baseline)
            .filter(|entry| {
                matches!(
                    entry,
                    pa_types::session::FileEntry::Message {
                        message: SessionAgentMessage::Assistant(assistant),
                        ..
                    } if assistant.stop_reason != pa_types::ai::StopReason::Error
                        && assistant.stop_reason != pa_types::ai::StopReason::Aborted
                )
            })
            .count();
        self.assistant_turns_since_review += settled as u32;
        self.entry_baseline = Some(entries.len());
    }

    /// The disposal drain (TS `dispose`: "a serialized compaction can finish
    /// without another model turn — drain its pending review here so
    /// disposal does not silently lose the trigger"). The print client's
    /// event subscription is already torn down at this point, so the
    /// round's surface stays off the stream: only the durable rows and
    /// the harness state persist. Best-effort, like the TS drain.
    pub(crate) async fn drain_compact_auto_refine_at_disposal(
        &mut self,
        engine: &SessionEngine,
        model: &Model,
        api_key: Option<String>,
        global_harness_dir: PathBuf,
    ) {
        let _ = self
            .consume_compact_auto_refine(
                engine,
                model,
                api_key,
                global_harness_dir,
                RefineSurface::Dispose,
            )
            .await;
    }

    /// The compact-trigger auto-refine consumption (TS
    /// `_runSerializedRefineCheckpointAfterBackground`'s compact arm plus
    /// `_runSerializedAutoRefineReview`): gates first — the session's
    /// refine surface, the `enabled`/`compact` settings, and the review
    /// cooldown — then the review, and only an approving review runs the
    /// refinement. The checkpoint surface preserves the trigger while the
    /// cooldown runs (TS keeps it for a later boundary); the disposal
    /// surface clears it. Every review attempt — decline, success, or
    /// failure — stamps the cooldown and resets the turn counter.
    pub(super) async fn consume_compact_auto_refine(
        &mut self,
        engine: &SessionEngine,
        model: &Model,
        api_key: Option<String>,
        global_harness_dir: PathBuf,
        surface: RefineSurface,
    ) -> Result<(), String> {
        if !self.compact_auto_refine_pending {
            return Ok(());
        }
        // TS `_autoRefineAllowedForSession`: sessions without the refine
        // surface drop the trigger outright.
        if !engine.session.auto_refine_allowed() {
            self.compact_auto_refine_pending = false;
            return Ok(());
        }
        let gates = engine.session.auto_refine_gates();
        if !gates.enabled || !gates.compact {
            self.compact_auto_refine_pending = false;
            return Ok(());
        }
        let under_cooldown = self
            .last_auto_refine_review_at
            .is_some_and(|last| now_millis().saturating_sub(last) < gates.cooldown_ms);
        if under_cooldown && surface == RefineSurface::Checkpoint {
            // Preserve the compact trigger for a later boundary (TS keeps
            // the pending flag while the cooldown is active).
            return Ok(());
        }
        self.compact_auto_refine_pending = false;
        if under_cooldown {
            // The disposal drain clears a cooled-down trigger without a
            // review (TS dispose).
            return Ok(());
        }
        let entries_before = engine.session.entries().await.len();
        let turns = self.assistant_turns_since_review;
        let outcome = engine
            .session
            // The headless print boundary never moves branches (the
            // session is single-branch for the run), so the branch
            // invalidation version stays at its initial 0.
            .auto_refine_after_compaction(model, api_key, global_harness_dir, turns, 0)
            .await;
        // Every review attempt stamps the cooldown and resets the turn
        // counter (TS stamps decline, success, and failure alike).
        self.last_auto_refine_review_at = Some(now_millis());
        self.assistant_turns_since_review = 0;
        // The reviewer declined: no refinement, nothing surfaces.
        let streamed = match outcome {
            Ok(None) => return Ok(()),
            Ok(Some(result)) => Ok(result),
            Err(error) => Err(error),
        };
        self.stream_refinement_outcome(
            engine,
            &streamed,
            entries_before,
            surface == RefineSurface::Checkpoint,
            "automatic",
        )
        .await;
        Ok(())
    }

    /// One refinement outcome's TS surface: the durable rows' message
    /// pairs plus `refine_complete` on success, the `refine_failed` event
    /// on failure. `emit` false (the disposal drain) keeps the stream
    /// quiet — the rows still persist. Text mode prints the failure's
    /// stderr diagnostic.
    pub(super) async fn stream_refinement_outcome(
        &self,
        engine: &SessionEngine,
        outcome: &anyhow::Result<pa_core::refinement::RefinementResult>,
        entries_before: usize,
        emit: bool,
        kind: &str,
    ) {
        match outcome {
            Ok(result) => {
                if emit && self.json_mode {
                    // The refinement rows this run appended (TS
                    // `_appendDurableRefineMessage`: the outcome row always,
                    // the model-facing notice when edits applied).
                    for row in Self::refinement_rows_since(engine, entries_before).await {
                        let value = crate::headless_autonomous::custom_row_wire_value(&row);
                        for event_type in ["message_start", "message_end"] {
                            (self.sink)(&json!({ "type": event_type, "message": value }));
                        }
                    }
                    self.emit_json(json!({
                        "type": "refine_complete",
                        "result": serde_json::to_value(result)
                            .unwrap_or(serde_json::Value::Null),
                    }));
                }
            }
            Err(error) => {
                if emit {
                    if self.json_mode {
                        self.emit_json(json!({
                            "type": "refine_failed",
                            "error": format!("{error}"),
                        }));
                    } else {
                        eprintln!("pa-cli: {kind} refinement failed: {error:#}");
                    }
                }
            }
        }
    }

    /// The durable refinement rows appended after an entry count (the
    /// outcome row, then the model-facing notice when edits applied; both
    /// land in that order, so the tail scan reads them in TS emission
    /// order).
    pub(crate) async fn refinement_rows_since(
        engine: &SessionEngine,
        entries_before: usize,
    ) -> Vec<pa_types::session::CustomMessage> {
        engine
            .session
            .entries()
            .await
            .into_iter()
            .skip(entries_before)
            .filter_map(|entry| match entry {
                pa_types::session::FileEntry::CustomMessage { payload, base }
                    if payload.custom_type
                        == pa_core::session_engine::refine::REFINEMENT_OUTCOME_CUSTOM_TYPE
                        || payload.custom_type
                            == pa_core::session_engine::refine::REFINEMENT_NOTICE_CUSTOM_TYPE =>
                {
                    Some(pa_types::session::CustomMessage {
                        custom_type: payload.custom_type.clone(),
                        content: payload.content.clone(),
                        display: payload.display,
                        details: payload.details.clone(),
                        timestamp: base
                            .timestamp
                            .as_deref()
                            .map(pa_core::session::timestamp_to_millis)
                            .unwrap_or_default(),
                        rest: payload.rest,
                    })
                }
                _ => None,
            })
            .collect()
    }
}
