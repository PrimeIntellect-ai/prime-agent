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
//!   boundary. The turn loop never consumes the round: the worker
//!   services the armed trigger off each turn's settle, in a background
//!   task after the queued prompts resolved — the compaction's settled
//!   turn and the next prompt's admission never wait on the review's
//!   model call (TS `setTimeout(0)`; the inline-before-`Done` shape held
//!   the next prompt behind the whole review — the compaction
//!   completion-stall measurement pinned it).
//! * ACP (serializedRefine true) uses the serialized path: a compaction
//!   arms the trigger and the serialized checkpoint between turns
//!   consumes it (after the requested `refine.run`), with the session
//!   close draining a trigger no turn serviced (TS `dispose`).

use pa_core::refinement::RefinementResult;
use pa_core::session_engine::auto_refine_trigger::CompactAutoRefineSurface;

use crate::agent_engine::AgentSessionEngine;

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
    /// message_end increment).
    pub(crate) fn note_settled_turn_since_auto_refine_review(&self) {
        let guard = self.session.blocking_lock();
        if let Some(engine) = guard.as_deref() {
            self.runtime
                .block_on(async { engine.session.note_settled_turn_since_auto_refine_review() });
        }
    }

    /// The shared round body (the `compact` command path and the turn
    /// settle both run it): the pending pre-check, the TS busy gates
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
        // The lock covers the clone only (see `run_compaction`): the
        // review below is a summarizer-style model call, and holding the
        // session mutex across it serialized every client read seam
        // behind the review — the same stall class the compaction itself
        // already fixed. The cloned engine keeps the round alive across a
        // racing rebuild; the round's gates are read before the call.
        let engine = {
            let guard = self.session.blocking_lock();
            guard.as_deref().map(std::sync::Arc::clone)
        };
        let Some(engine) = engine else {
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

    /// The faux model's per-request output budget (maxTokens 16_384 under the
    /// 32_000 request cap): threshold fixtures subtract it from the window
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

    /// A settled compaction arms its compact-trigger review but never
    /// consumes it on the turn path: the threshold arm fires on the
    /// crossing turn and the run settles with the trigger still armed
    /// (TS schedules the review in the background after the settle — the
    /// inline-before-`Done` shape held the queued next prompt behind the
    /// review's model call); the worker's servicing body (the same
    /// `consume_compact_auto_refine` the `/compact` command path uses)
    /// then consumes the queued decline, and the NEXT turn after the
    /// servicing sees the reply queued after the decline.
    #[test]
    fn threshold_compaction_arms_the_review_off_the_turn_path() {
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
        // The threshold arm compacted; the turn settled WITHOUT consuming
        // the review: no refinement rows, and the trigger stays armed for
        // the worker's settle servicing.
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
            "the turn path surfaced no review rows"
        );
        assert!(
            engine.compact_auto_refine_pending(),
            "the trigger stayed armed off the turn path"
        );
        // The worker's servicing body consumes the queued decline and
        // surfaces nothing (the decline's silent contract).
        let consumed = engine.consume_compact_auto_refine().expect("the round ran");
        assert!(consumed.is_none(), "the decline surfaced nothing");
        assert!(
            !engine.compact_auto_refine_pending(),
            "the servicing consumed the trigger"
        );
        // The review consumed the decline: the third turn sees the reply
        // queued after it, not the decline itself.
        admit(&engine, "third turn".to_string(), &mut events);
        assert_eq!(
            assistant_texts(&events).last().map(String::as_str),
            Some("third reply"),
            "the serviced review consumed the queued decline"
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
