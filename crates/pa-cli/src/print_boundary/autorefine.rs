//! The compact-trigger auto-refine machine: the review gates, the durable-row
//! surface, the requested-refinement streaming, and the disposal drain.

use super::{json, Model, PathBuf, SessionAgentMessage, SessionEngine, TurnBoundary};

/// Wall-clock milliseconds (the review-cooldown stamps).
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

/// Where the compact-trigger auto-refine surfaces: the serialized checkpoint runs
/// mid-run; the disposal drain runs after the print client tore its subscription.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RefineSurface {
    /// The serialized checkpoint at a turn boundary.
    Checkpoint,
    /// The session disposal drain (best-effort, silent).
    Dispose,
}

impl TurnBoundary {
    pub(super) fn report_background_refinement(
        &mut self,
        pending: tokio::task::JoinHandle<anyhow::Result<pa_core::refinement::RefinementResult>>,
        source: pa_core::session_engine::refine::RefinementSource,
    ) {
        let pending = tokio::spawn(async move {
            pending
                .await
                .unwrap_or_else(|error| Err(anyhow::anyhow!("refinement task failed: {error}")))
                .map(Some)
        });
        self.report_optional_refinement(pending, source, /*emit*/ true);
    }

    fn report_optional_refinement(
        &mut self,
        pending: tokio::task::JoinHandle<
            anyhow::Result<Option<pa_core::refinement::RefinementResult>>,
        >,
        source: pa_core::session_engine::refine::RefinementSource,
        emit: bool,
    ) {
        let sink = self.sink.clone();
        let json_mode = self.json_mode;
        self.refinement_reports.retain(|job| !job.is_finished());
        self.refinement_reports.push(tokio::spawn(async move {
            let outcome = pending
                .await
                .unwrap_or_else(|error| Err(anyhow::anyhow!("refinement task failed: {error}")));
            if !emit {
                return;
            }
            match outcome {
                Ok(Some(result)) if json_mode => {
                    let mut rows = vec![
                        pa_core::session_engine::refine::create_refinement_outcome_message(&result),
                    ];
                    if result.applied_edits.iter().any(|edit| edit.applied) {
                        rows.push(
                            pa_core::session_engine::refine::create_refinement_notice_message(
                                &result, source,
                            ),
                        );
                    }
                    for row in rows {
                        let value = crate::headless_autonomous::custom_row_wire_value(&row);
                        for event_type in ["message_start", "message_end"] {
                            sink(&json!({ "type": event_type, "message": value }));
                        }
                    }
                    sink(&json!({ "type": "refine_complete", "result": result }));
                }
                Ok(_) => {}
                Err(error) if json_mode => {
                    sink(&json!({ "type": "refine_failed", "error": format!("{error:#}") }));
                }
                Err(error) => eprintln!("pa-cli: refinement failed: {error:#}"),
            }
        }));
    }

    pub(super) async fn wait_for_refinement_reports(&mut self) {
        for pending in self.refinement_reports.drain(..) {
            pending.await.expect("refinement reporting task");
        }
    }

    /// The settled non-error, non-aborted assistant turns appended since the last
    /// boundary call, added to the review prompt's trigger counter.
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

    /// The disposal drain: a serialized compaction can finish without another model
    /// turn — drain its pending review here so disposal does not lose the
    /// trigger. The subscription is already torn down; only durable rows and
    /// harness state persist.
    ///
    /// The drain owns finishing the pending refinement work: the session drops
    /// as soon as its caller returns, and that drop aborts in-flight refinement
    /// planning, so a report already running — and the review this drain starts
    /// off a retained trigger — must land its rows first. Awaiting the running
    /// reports before the consume also keeps the coalescing gate inside it from
    /// retiring the trigger at disposal, the last boundary that can service it.
    pub(crate) async fn drain_compact_auto_refine_at_disposal(
        &mut self,
        engine: &SessionEngine,
        model: &Model,
        api_key: Option<String>,
        global_harness_dir: PathBuf,
    ) {
        self.wait_for_refinement_reports().await;
        self.consume_compact_auto_refine(
            engine,
            model,
            api_key,
            global_harness_dir,
            RefineSurface::Dispose,
        );
        self.wait_for_refinement_reports().await;
    }

    /// The compact-trigger auto-refine consumption: gates first — the refine
    /// surface, the settings, the review cooldown — then the review, and only
    /// an approving review runs the refinement. The checkpoint preserves the
    /// trigger through the cooldown; disposal clears it; each attempt stamps
    /// the cooldown and resets the counter.
    pub(super) fn consume_compact_auto_refine(
        &mut self,
        engine: &SessionEngine,
        model: &Model,
        api_key: Option<String>,
        global_harness_dir: PathBuf,
        surface: RefineSurface,
    ) {
        if !self.compact_auto_refine_pending {
            return;
        }
        if self.refinement_reports.iter().any(|job| !job.is_finished()) {
            // Coalesce triggers while a review or requested refinement is still
            // running. The next boundary can service the retained trigger.
            return;
        }
        // Sessions without the refine surface drop the trigger
        // outright.
        if !engine.session.auto_refine_allowed() {
            self.compact_auto_refine_pending = false;
            return;
        }
        let gates = engine.session.auto_refine_gates();
        if !gates.enabled || !gates.compact {
            self.compact_auto_refine_pending = false;
            return;
        }
        let under_cooldown = self
            .last_auto_refine_review_at
            .is_some_and(|last| now_millis().saturating_sub(last) < gates.cooldown_ms);
        if under_cooldown && surface == RefineSurface::Checkpoint {
            // Preserve the compact trigger for a later boundary while
            // the cooldown is active.
            return;
        }
        self.compact_auto_refine_pending = false;
        if under_cooldown {
            // The disposal drain clears a cooled-down trigger without a
            // review.
            return;
        }
        let turns = self.assistant_turns_since_review;
        let pending = engine.session.start_auto_refine_after_compaction(
            model.clone(),
            api_key,
            global_harness_dir,
            turns,
            0,
        );
        // Stamp admission, not completion: a held review cannot start duplicates
        // at every user turn while its provider call remains in flight.
        self.last_auto_refine_review_at = Some(now_millis());
        self.assistant_turns_since_review = 0;
        self.report_optional_refinement(
            pending,
            pa_core::session_engine::refine::RefinementSource::Auto,
            surface == RefineSurface::Checkpoint,
        );
    }
}
