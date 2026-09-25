//! The compact-trigger auto-refine scheduling on the daemon surfaces: the
//! TS compact trigger (agent-session.ts `_scheduleAutoRefineAfterCompaction`
//! and the review consumption) wired onto the two transports that host the
//! compaction arms.
//!
//! TS ground truth: the review is scheduled after *every* successful
//! compaction — manual `/compact` and the automatic arms alike — on every
//! transport, because the arms live inside the session turn loop. The two
//! TS servicing shapes map onto the Rust surfaces by their app mode
//! (main.ts `serializedRefine: appMode !== "interactive" && appMode !==
//! "daemon"`):
//!
//! * the daemon worker (`--mode daemon`, serializedRefine false) uses the
//!   interactive path: a compaction arms the trigger, the background
//!   `_maybeAutoRefine("compact")` runs the review while the session is
//!   idle, and streaming/compacting or queued work defers it to the next
//!   boundary. The worker's turn loop is synchronous between turns, so
//!   the round runs inline at the quiescent boundary — the same review,
//!   the same gates, before the run's `Done` reaches attached clients.
//! * ACP (serializedRefine true) uses the serialized path: a compaction
//!   arms the trigger and the serialized checkpoint between turns
//!   consumes it (after the requested `refine.run`), with the session
//!   close draining a trigger no turn serviced (TS `dispose`).

use pa_core::refinement::RefinementResult;
use pa_core::session_engine::auto_refine_trigger::CompactAutoRefineSurface;
use pa_core::session_engine::refine::{
    create_refinement_notice_message, create_refinement_outcome_message, RefinementSource,
};

use crate::agent_engine::AgentSessionEngine;
use crate::engine::EngineEvent;

impl AgentSessionEngine {
    /// Whether a compaction armed the compact-trigger review on the built
    /// session (TS `_compactAutoRefinePending`).
    pub(crate) fn compact_auto_refine_pending(&self) -> bool {
        let guard = self.session.blocking_lock();
        match guard.as_deref() {
            Some(engine) => self
                .runtime
                .block_on(async { engine.session.compact_auto_refine_pending() }),
            None => false,
        }
    }

    /// Arm the trigger after one successful compaction (TS
    /// `_scheduleAutoRefineAfterCompaction`): no-op on sessions without
    /// the refine surface.
    pub(crate) fn mark_compact_auto_refine_pending(&self) {
        let guard = self.session.blocking_lock();
        if let Some(engine) = guard.as_deref() {
            self.runtime
                .block_on(async { engine.session.mark_compact_auto_refine_pending() });
        }
    }

    /// Count one settled non-error assistant turn into the review
    /// prompt's turn line (TS `_assistantTurnsSinceAutoRefine`'s
    /// `message_end` increment).
    pub(crate) fn note_settled_turn_since_auto_refine_review(&self) {
        let guard = self.session.blocking_lock();
        if let Some(engine) = guard.as_deref() {
            self.runtime
                .block_on(async { engine.session.note_settled_turn_since_auto_refine_review() });
        }
    }

    /// Consume an armed trigger at one quiescent turn boundary (TS
    /// `_maybeAutoRefine("compact")`'s gate order): the busy gates keep
    /// the trigger armed — a streaming session or queued work defers the
    /// round to the next boundary, exactly the TS pending-flag deferral.
    /// An approved review broadcasts the refinement's durable rows
    /// (the outcome row and, when edits applied, the model-facing notice)
    /// through the turn loop's emit, so attached clients see the same
    /// pairs the `/refine` command produces; a failed round keeps the
    /// worker log surface (the daemon wire has no refine events).
    /// Returns whether the emitter stayed alive.
    pub(crate) fn run_compact_auto_refine(
        &self,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) -> bool {
        let outcome = self.consume_compact_auto_refine_round();
        self.emit_compact_auto_refine_outcome(outcome, emit)
    }

    /// One round's outcome surface: the decline (and every silent gate)
    /// stays quiet — TS surfaces nothing on a declined review — while an
    /// approved round broadcasts its rows and a failure logs.
    fn emit_compact_auto_refine_outcome(
        &self,
        outcome: anyhow::Result<Option<RefinementResult>>,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) -> bool {
        let Ok(Some(result)) = outcome else {
            if let Err(error) = outcome {
                eprintln!("pa-daemon: auto-refinement after compaction failed: {error:#}");
            }
            return true;
        };
        // TS `refine()` appends the TUI outcome row and the model-facing
        // notice (when edits applied) as durable rows; the worker
        // broadcasts both like the `/refine` command, and its emit
        // persists them to the session file.
        let outcome_row = create_refinement_outcome_message(&result);
        if !emit(EngineEvent::CustomMessage(
            crate::session_commands::custom_message_value(&outcome_row),
        )) {
            return false;
        }
        if result.applied_edits.iter().any(|edit| edit.applied) {
            let notice = create_refinement_notice_message(&result, RefinementSource::Auto);
            if !emit(EngineEvent::CustomMessage(
                crate::session_commands::custom_message_value(&notice),
            )) {
                return false;
            }
        }
        true
    }

    /// The shared round body (the `compact` command path and the turn
    /// boundary both run it): the pending pre-check, the TS busy gates
    /// (streaming or queued work keeps the trigger armed for the next
    /// boundary), then the pa-core consumption with its gate/review/stamp
    /// sequence. `Ok(None)` is every silent outcome.
    pub(crate) fn consume_compact_auto_refine_round(
        &self,
    ) -> anyhow::Result<Option<RefinementResult>> {
        if !self.compact_auto_refine_pending() {
            return Ok(None);
        }
        // TS `_maybeAutoRefine` defers while the agent is active
        // (streaming or compacting) and the compact-trigger scheduling
        // defers behind queued work; the worker's consumption points are
        // quiescent, so only the queued-work check remains live here.
        let busy = {
            let guard = self.session.blocking_lock();
            match guard.as_deref() {
                Some(engine) => self
                    .runtime
                    .block_on(async { engine.session.agent().has_queued_messages() }),
                None => false,
            }
        };
        if busy {
            return Ok(None);
        }
        // The session's live model (the provider target the turn stream
        // reads): the compact-trigger review is a summarizer-style model
        // call, so it follows the session's provider like the compaction
        // that armed it (R8).
        let Ok(model) = self.session_model() else {
            // TS `_maybeAutoRefine` keeps the trigger armed when no model
            // is selected; the next boundary retries.
            return Ok(None);
        };
        let api_key = self.resolve_request_api_key(&model);
        let global_harness_dir = self.config.agent_dir.clone();
        let guard = self.session.blocking_lock();
        let Some(engine) = guard.as_deref() else {
            return Ok(None);
        };
        self.runtime.block_on(async {
            engine
                .session
                .consume_compact_auto_refine(
                    &model,
                    api_key,
                    global_harness_dir,
                    CompactAutoRefineSurface::Checkpoint,
                )
                .await
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::agent_engine::tests::{admit, faux_engine_with_settings};
    use crate::agent_engine::AgentSessionEngine;
    use crate::agent_engine::FAUX_TEST_LOCK;
    use crate::engine::SessionEngine;
    use crate::engine::{CompactionOutcome, CompactionRequest, EngineEvent};
    use serde_json::json;

    /// The faux model's per-request output budget (maxTokens `16_384` under the
    /// `32_000` request cap): threshold fixtures subtract it from the window
    /// alongside the headroom (the combined input+output ceiling).
    const FAUX_REQUEST_BUDGET: u64 = 16_384;

    /// A declining review reply (the TS `AutoRefineReview` JSON shape).
    const DECLINE: &str = r#"{"shouldRefine": false, "rationale": "one-off tool output"}"#;

    /// One engine whose sessions carry the conversation log the harness
    /// dir derives from (the worker shape: sessions with the refine
    /// surface), or without one (sessions that never auto-refine).
    fn trigger_engine(
        script: serde_json::Value,
        reserve_tokens: u64,
        with_session_file: bool,
    ) -> (AgentSessionEngine, tempfile::TempDir) {
        let (engine, dir) = faux_engine_with_settings(script, reserve_tokens);
        if with_session_file {
            let sessions = dir.path().join("sessions");
            std::fs::create_dir_all(&sessions).unwrap();
            engine.set_session_file(sessions.join("trigger-session.jsonl"));
        }
        (engine, dir)
    }

    fn assistant_texts(events: &[EngineEvent]) -> Vec<String> {
        events
            .iter()
            .filter_map(|event| match event {
                EngineEvent::AssistantMessage(value) => Some(
                    value["content"][0]["text"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string(),
                ),
                _ => None,
            })
            .collect()
    }

    fn refinement_rows(events: &[EngineEvent]) -> Vec<&serde_json::Value> {
        events
            .iter()
            .filter_map(|event| match event {
                EngineEvent::CustomMessage(row) => Some(row),
                _ => None,
            })
            .filter(|row| {
                row["customType"] == "refinement_outcome"
                    || row["customType"] == "refinement_notice"
            })
            .collect()
    }

    /// The reserve headroom between one small turn's usage and a big
    /// crossing turn's (the f14 battery shape): the small turns stay
    /// below, the big turns cross, environment-independently.
    fn crossing_headroom() -> u64 {
        let (probe, _probe_dir) =
            faux_engine_with_settings(json!({ "responses": [{"text": "seed reply"}] }), 1);
        let mut probe_events: Vec<EngineEvent> = Vec::new();
        admit(&probe, "seed turn".to_string(), &mut probe_events);
        let baseline = probe_events
            .iter()
            .find_map(|event| match event {
                EngineEvent::AssistantMessage(message) => message["usage"]["totalTokens"].as_u64(),
                _ => None,
            })
            .expect("probe turn produced usage");
        drop(probe);
        let big_tokens = (48_000 + "seed turn  crossing".len() as u64).div_ceil(4);
        baseline + big_tokens / 2
    }

    /// A settled compaction runs its compact-trigger review: the threshold
    /// arm fires on the crossing turn, the review request consumes the
    /// queued decline before the next turn runs, and the decline surfaces
    /// nothing (no refinement rows — the queued replies prove the
    /// consumption order).
    #[test]
    fn threshold_compaction_runs_the_compact_trigger_review() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let headroom = crossing_headroom();
        let (engine, _dir) = trigger_engine(
            json!({
                "responses": [
                    {"text": "seed reply"},
                    {"text": "crossing reply"},
                    {"text": "the summary"},
                    {"text": DECLINE},
                    {"text": "third reply"},
                ]
            }),
            128_000u64
                .saturating_sub(FAUX_REQUEST_BUDGET + headroom)
                .max(1),
            true,
        );
        let big_prompt = format!("seed turn {} crossing", "x".repeat(48_000));
        let mut events: Vec<EngineEvent> = Vec::new();
        admit(&engine, "seed turn".to_string(), &mut events);
        admit(&engine, big_prompt, &mut events);
        // The threshold arm compacted and its review declined.
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, EngineEvent::CompactionStart { .. }))
                .count(),
            1,
            "the threshold compaction ran"
        );
        assert!(
            refinement_rows(&events).is_empty(),
            "the decline surfaced nothing"
        );
        assert!(
            !engine.compact_auto_refine_pending(),
            "the trigger was consumed"
        );
        // The review consumed the decline: the third turn sees the reply
        // queued after it, not the decline itself.
        admit(&engine, "third turn".to_string(), &mut events);
        assert_eq!(
            assistant_texts(&events).last().map(String::as_str),
            Some("third reply"),
            "the review consumed the queued decline"
        );
    }

    /// Every review attempt stamps the cooldown (the TS contract): a
    /// re-armed trigger holds at the boundary — no second review request
    /// runs, and the trigger stays pending for a later boundary.
    #[test]
    fn the_declining_review_stamps_the_cooldown() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // reserve 1: the headroom never crosses, so only the manual
        // compaction runs.
        let (engine, _dir) = trigger_engine(
            json!({
                "responses": [
                    {"text": "first reply"},
                    {"text": "second reply"},
                    {"text": "the summary"},
                    {"text": DECLINE},
                    {"text": "third reply"},
                ]
            }),
            1,
            true,
        );
        let mut events: Vec<EngineEvent> = Vec::new();
        admit(
            &engine,
            format!("first turn {}", "x".repeat(48_000)),
            &mut events,
        );
        admit(
            &engine,
            format!("second turn {}", "x".repeat(48_000)),
            &mut events,
        );
        let controller = std::sync::Arc::new(pa_agent::abort::AbortController::new());
        let outcome = engine.run_compaction(
            CompactionRequest {
                custom_instructions: None,
            },
            &controller.signal(),
        );
        assert!(
            matches!(outcome, CompactionOutcome::Compacted { .. }),
            "the manual compaction ran"
        );
        assert!(engine.compact_auto_refine_pending(), "the trigger armed");
        // Round one: the review declines.
        let consumed = engine.consume_compact_auto_refine().expect("the round ran");
        assert!(consumed.is_none(), "the decline surfaced nothing");
        assert!(
            !engine.compact_auto_refine_pending(),
            "the trigger consumed"
        );
        // A second compaction arms the trigger again; the cooldown holds
        // it at the boundary — no review request, and the trigger stays
        // pending for a later boundary (TS keeps the pending flag while
        // the cooldown runs).
        engine.mark_compact_auto_refine_pending();
        let held = engine
            .consume_compact_auto_refine()
            .expect("the held round ran");
        assert!(held.is_none(), "no review under the cooldown");
        assert!(
            engine.compact_auto_refine_pending(),
            "the checkpoint preserved the trigger"
        );
        // No review request consumed the queue: the third turn sees the
        // reply queued after the decline.
        admit(&engine, "third turn".to_string(), &mut events);
        assert_eq!(
            assistant_texts(&events).last().map(String::as_str),
            Some("third reply"),
            "the cooldown held the trigger without a review request"
        );
        assert!(
            engine.compact_auto_refine_pending(),
            "the trigger stayed armed through the turn boundary"
        );
    }

    /// The refine-surface gate (TS `_autoRefineAllowedForSession`): a
    /// session without the local harness dir compacts without ever
    /// running a review.
    #[test]
    fn sessions_without_the_refine_surface_never_run_a_review() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let headroom = crossing_headroom();
        let (engine, _dir) = trigger_engine(
            json!({
                "responses": [
                    {"text": "seed reply"},
                    {"text": "crossing reply"},
                    {"text": "the summary"},
                    {"text": "third reply"},
                    {"text": "fourth reply"},
                ]
            }),
            128_000u64
                .saturating_sub(FAUX_REQUEST_BUDGET + headroom)
                .max(1),
            false,
        );
        let big_prompt = format!("seed turn {} crossing", "x".repeat(48_000));
        let mut events: Vec<EngineEvent> = Vec::new();
        admit(&engine, "seed turn".to_string(), &mut events);
        admit(&engine, big_prompt, &mut events);
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, EngineEvent::CompactionStart { .. }))
                .count(),
            1,
            "the threshold compaction ran"
        );
        admit(&engine, "third turn".to_string(), &mut events);
        // No review consumed the queue: the third turn sees the reply
        // queued right after the summarizer's.
        assert_eq!(
            assistant_texts(&events).last().map(String::as_str),
            Some("third reply"),
            "no review ran without the refine surface"
        );
        assert!(
            !engine.compact_auto_refine_pending(),
            "the trigger never armed without the refine surface"
        );
    }

    /// The manual compaction (`compact` command) arms and consumes the
    /// round through the same gated body (TS `compact()`'s background
    /// scheduling on an idle session): the decline is consumed before
    /// the next turn, and nothing surfaces.
    #[test]
    fn manual_compaction_arms_and_consumes_the_round() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, _dir) = trigger_engine(
            json!({
                "responses": [
                    {"text": "first reply"},
                    {"text": "second reply"},
                    {"text": "the summary"},
                    {"text": DECLINE},
                    {"text": "third reply"},
                ]
            }),
            1,
            true,
        );
        let mut events: Vec<EngineEvent> = Vec::new();
        admit(
            &engine,
            format!("first turn {}", "x".repeat(48_000)),
            &mut events,
        );
        admit(
            &engine,
            format!("second turn {}", "x".repeat(48_000)),
            &mut events,
        );
        let controller = std::sync::Arc::new(pa_agent::abort::AbortController::new());
        let outcome = engine.run_compaction(
            CompactionRequest {
                custom_instructions: None,
            },
            &controller.signal(),
        );
        assert!(
            matches!(outcome, CompactionOutcome::Compacted { .. }),
            "the manual compaction ran"
        );
        assert!(
            engine.compact_auto_refine_pending(),
            "the manual compaction armed the trigger"
        );
        let consumed = engine.consume_compact_auto_refine().expect("the round ran");
        assert!(consumed.is_none(), "the decline surfaced nothing");
        assert!(
            !engine.compact_auto_refine_pending(),
            "the trigger was consumed"
        );
        assert!(
            refinement_rows(&events).is_empty(),
            "the decline surfaced nothing"
        );
        admit(&engine, "third turn".to_string(), &mut events);
        assert_eq!(
            assistant_texts(&events).last().map(String::as_str),
            Some("third reply"),
            "the review consumed the queued decline"
        );
    }
}
