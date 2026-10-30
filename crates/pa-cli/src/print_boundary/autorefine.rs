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
    /// `fails_run`: a failed `/refine` command fails the print run (exit 1); a
    /// model-requested refinement only reports its failure.
    pub(crate) fn report_background_refinement(
        &mut self,
        pending: tokio::task::JoinHandle<
            anyhow::Result<pa_core::session_engine::refine::CommittedRefinement>,
        >,
        fails_run: bool,
    ) {
        let pending = tokio::spawn(async move {
            pending
                .await
                .unwrap_or_else(|error| Err(anyhow::anyhow!("refinement task failed: {error}")))
                .map(Some)
        });
        self.report_optional_refinement(pending, /*emit*/ true, fails_run);
    }

    /// Whether a `/refine` command's background refinement failed; read after
    /// the disposal drain has awaited every report.
    pub(crate) fn refine_command_failed(&self) -> bool {
        self.refine_command_failed
            .load(std::sync::atomic::Ordering::Acquire)
    }

    fn report_optional_refinement(
        &mut self,
        pending: tokio::task::JoinHandle<
            anyhow::Result<Option<pa_core::session_engine::refine::CommittedRefinement>>,
        >,
        emit: bool,
        fails_run: bool,
    ) {
        let sink = self.sink.clone();
        let json_mode = self.json_mode;
        let refine_command_failed = self.refine_command_failed.clone();
        self.refinement_reports.retain(|job| !job.is_finished());
        self.refinement_reports.push(tokio::spawn(async move {
            let outcome = pending
                .await
                .unwrap_or_else(|error| Err(anyhow::anyhow!("refinement task failed: {error}")));
            if fails_run && outcome.is_err() {
                refine_command_failed.store(true, std::sync::atomic::Ordering::Release);
            }
            if !emit {
                return;
            }
            match outcome {
                Ok(Some(committed)) if json_mode => {
                    for row in committed.rows {
                        let value = crate::headless_autonomous::custom_row_wire_value(&row);
                        for event_type in ["message_start", "message_end"] {
                            sink(&json!({ "type": event_type, "message": value }));
                        }
                    }
                    sink(&json!({ "type": "refine_complete", "result": committed.result }));
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
    /// Awaits in-flight refinement reports before and after consuming the
    /// trigger: the session drops as soon as its caller returns, and that drop
    /// aborts the refinement planning behind any report the drain leaves
    /// running (the first wait also clears the coalescing gate so a retained
    /// trigger is serviced at this, its last, boundary).
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
            surface == RefineSurface::Checkpoint,
            /*fails_run*/ false,
        );
    }
}
