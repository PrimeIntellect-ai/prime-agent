//! The compact-trigger auto-refine scheduling (TS `_scheduleAutoRefineAfterCompaction`, armed
//! after every successful compaction): the daemon worker services the trigger off each turn's
//! settle in a background task — the round is the refinement child's spawn (fire-and-wake;
//! the child's proposal applies on its reply's arrival). ACP consumes it at the serialized
//! checkpoint between turns.

use pa_core::session_engine::auto_refine_trigger::CompactAutoRefineSurface;
use pa_core::session_engine::refine::RefinementSource;

use crate::agent_engine::AgentSessionEngine;
use crate::engine::SessionEngine as _;

impl AgentSessionEngine {
    /// Whether a compaction armed the compact-trigger round on the built
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
    /// `_scheduleAutoRefineAfterCompaction`): no-op without the refine surface.
    pub(crate) fn mark_compact_auto_refine_pending(&self) {
        let guard = self.session.blocking_lock();
        if let Some(engine) = guard.as_deref() {
            self.runtime
                .block_on(async { engine.session.mark_compact_auto_refine_pending() });
        }
    }

    /// Count one settled non-error assistant turn into the round's turn
    /// counter (TS `_assistantTurnsSinceAutoRefine`'s `message_end` increment).
    pub(crate) fn note_settled_turn_since_auto_refine_review(&self) {
        let guard = self.session.blocking_lock();
        if let Some(engine) = guard.as_deref() {
            self.runtime
                .block_on(async { engine.session.note_settled_turn_since_auto_refine_review() });
        }
    }

    /// The shared round body (the `compact` command path and the turn
    /// settle both run it): the pending pre-check, the TS busy gates, the
    /// pa-core round take, then the refinement child's spawn. The gates
    /// (enabled, compact, cooldown, the in-flight guard) live on the
    /// session's trigger state; the review gate is gone — the child's own
    /// empty-edits judgment is the gate. `Ok(())` is every silent outcome;
    /// the spawn's errors surface.
    pub(crate) fn consume_compact_auto_refine_round(&self) -> anyhow::Result<()> {
        if !self.compact_auto_refine_pending() {
            return Ok(());
        }
        // TS `_maybeAutoRefine` defers while the agent is active and behind
        // queued work; only the queued-work check remains live here.
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
            return Ok(());
        }
        // A refinement child that died without replying releases its
        // round before the take, so the armed trigger is never wedged
        // behind the in-flight guard.
        self.runtime
            .block_on(async { self.release_dead_refine_child_round().await });
        // A live refinement child (a manual `/refine` spawn whose reply has
        // not landed) owns the apply lane: taking the armed round now would
        // only fail the spawn against it and surface a spurious
        // `refine_failed`. The trigger stays armed for a later boundary.
        if self
            .refine_flight
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_some()
        {
            return Ok(());
        }
        // The round take: the gates decide and stamp the cadence; the
        // in-flight guard holds the trigger while the child runs.
        let options = {
            let guard = self.session.blocking_lock();
            match guard.as_deref() {
                Some(engine) => self.runtime.block_on(async {
                    engine
                        .session
                        .take_compact_auto_refine_round(CompactAutoRefineSurface::Checkpoint)
                }),
                None => None,
            }
        };
        let Some(options) = options else {
            return Ok(());
        };
        // Fire: the spawn returns once the child is admitted; the child's
        // proposal applies on its reply's arrival (the wake finishes the
        // round either way). A failed spawn releases the round here — its
        // error surfaced, so the next armed trigger is not wedged behind
        // the in-flight guard.
        if let Err(error) = self.spawn_refinement_child(options, RefinementSource::Auto) {
            let guard = self.session.blocking_lock();
            if let Some(engine) = guard.as_deref() {
                engine.session.finish_compact_auto_refine_round();
            }
            return Err(error);
        }
        Ok(())
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

    /// The faux model's per-request output budget (maxTokens `16_384` under the `32_000` cap):
    /// threshold fixtures subtract it from the window alongside the headroom.
    const FAUX_REQUEST_BUDGET: u64 = 16_384;

    /// One engine whose sessions carry the conversation log the harness dir derives from
    /// (the refine surface), or without one (sessions that never auto-refine).
    fn trigger_engine(
        script: &serde_json::Value,
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

    /// The reserve headroom between one small turn's usage and a big crossing turn's (the
    /// f14 battery shape): small turns stay below, big turns cross, environment-independently.
    fn crossing_headroom() -> u64 {
        let (probe, _probe_dir) =
            faux_engine_with_settings(&json!({ "responses": [{"text": "seed reply"}] }), 1);
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

    /// A settled compaction arms its compact-trigger round but never
    /// consumes it on the turn path (TS schedules it in the background
    /// after the settle); the worker's servicing body takes the round and
    /// spawns — the standalone engine refuses the spawn visibly (the
    /// refinement child needs the daemon).
    #[test]
    fn threshold_compaction_arms_the_round_off_the_turn_path() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let headroom = crossing_headroom();
        let (engine, _dir) = trigger_engine(
            &json!({
                "responses": [
                    {"text": "seed reply"},
                    {"text": "crossing reply"},
                    {"text": "the summary"},
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
            "the turn path surfaced no round rows"
        );
        assert!(
            engine.compact_auto_refine_pending(),
            "the trigger stayed armed off the turn path"
        );
        // The round was taken (the trigger consumed, the cooldown
        // stamped); the spawn refuses without the daemon and its error
        // surfaces — never a silent decline.
        let error = engine
            .consume_compact_auto_refine()
            .expect_err("the spawn refused");
        assert!(
            error.to_string().contains("daemon-backed"),
            "the refusal names the gate: {error}"
        );
        assert!(
            !engine.compact_auto_refine_pending(),
            "the servicing consumed the trigger"
        );
        admit(&engine, "third turn".to_string(), &mut events);
        assert_eq!(
            assistant_texts(&events).last().map(String::as_str),
            Some("third reply"),
            "the third turn answered"
        );
    }

    /// A live refinement child (a manual `/refine` spawn whose reply has
    /// not landed) owns the apply lane: the armed round never takes
    /// against it — the spawn would only collide and surface a spurious
    /// `refine_failed` — and the trigger stays armed for a later
    /// boundary. Red when the pre-take flight check is lost: the round
    /// takes and the spawn's error surfaces.
    #[test]
    fn an_armed_round_waits_out_a_live_refine_child_instead_of_failing() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, dir) =
            trigger_engine(&json!({ "responses": [ {"text": "seed reply"} ] }), 1, true);
        let mut events: Vec<EngineEvent> = Vec::new();
        admit(&engine, "seed turn".to_string(), &mut events);
        engine.mark_compact_auto_refine_pending();
        // The manual refinement child in flight (this engine has no child
        // runtime, so the dead-child probe cannot clear it).
        *engine
            .refine_flight
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some(crate::refine_children::RefineChildFlight {
                rlm_child_id: "rlm-child-1".to_string(),
                active_session_id: "active-1".to_string(),
                prepared: pa_core::session_engine::refine::PreparedRefinement {
                    options: pa_core::session_engine::refine::RefineOptions::default(),
                    requested_scope: pa_core::refinement::HarnessScope::Global,
                    baseline_state: pa_core::refinement::empty_harness_state(),
                    id: "refine_1".to_string(),
                },
                source: pa_core::session_engine::refine::RefinementSource::User,
                global_harness_dir: dir.path().join("harness"),
            });
        let outcome = engine.consume_compact_auto_refine();
        assert!(outcome.is_ok(), "the collision stays silent: {outcome:?}");
        assert!(
            engine.compact_auto_refine_pending(),
            "the trigger stays armed for the later boundary"
        );
    }

    /// A taken round stamps the cooldown (a failed spawn already
    /// surfaced); a re-armed trigger under the cooldown stays pending and
    /// silent at the checkpoint, and the failed spawn's in-flight release
    /// keeps the cadence un-wedged.
    #[test]
    fn a_taken_round_stamps_the_cooldown_and_the_failed_spawn_releases_the_round() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // reserve 1: the headroom never crosses, so only the manual
        // compaction runs.
        let (engine, _dir) = trigger_engine(
            &json!({
                "responses": [
                    {"text": "first reply"},
                    {"text": "second reply"},
                    {"text": "the summary"},
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
        // Round one: the take consumed the trigger and the spawn refused —
        // the standalone engine has no child runtime.
        engine
            .consume_compact_auto_refine()
            .expect_err("the spawn refused");
        assert!(
            !engine.compact_auto_refine_pending(),
            "the trigger consumed"
        );
        // The cooldown holds a re-armed trigger at the boundary (the take
        // is silent and the trigger stays pending).
        engine.mark_compact_auto_refine_pending();
        engine
            .consume_compact_auto_refine()
            .expect("the held round answered");
        assert!(
            engine.compact_auto_refine_pending(),
            "the cooldown preserved the trigger"
        );
        admit(&engine, "third turn".to_string(), &mut events);
        assert_eq!(
            assistant_texts(&events).last().map(String::as_str),
            Some("third reply"),
            "the cooldown held the trigger without a round"
        );
    }

    #[test]
    fn sessions_without_the_refine_surface_never_run_a_round() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let headroom = crossing_headroom();
        let (engine, _dir) = trigger_engine(
            &json!({
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
        assert_eq!(
            assistant_texts(&events).last().map(String::as_str),
            Some("third reply"),
            "no round ran without the refine surface"
        );
        assert!(
            !engine.compact_auto_refine_pending(),
            "the trigger never armed without the refine surface"
        );
    }

    #[test]
    fn manual_compaction_arms_and_consumes_the_round() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, _dir) = trigger_engine(
            &json!({
                "responses": [
                    {"text": "first reply"},
                    {"text": "second reply"},
                    {"text": "the summary"},
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
        // The round was taken; the spawn refused without the daemon.
        engine
            .consume_compact_auto_refine()
            .expect_err("the spawn refused");
        assert!(
            !engine.compact_auto_refine_pending(),
            "the trigger was consumed"
        );
        assert!(
            refinement_rows(&events).is_empty(),
            "the refused round surfaced no rows"
        );
        admit(&engine, "third turn".to_string(), &mut events);
        assert_eq!(
            assistant_texts(&events).last().map(String::as_str),
            Some("third reply"),
            "the third turn answered"
        );
    }

    /// `/refine` without a rollback refuses on the standalone engine (the
    /// planning refinement is the refinement child's — the daemon-backed
    /// command host spawns it): the refusal is the command's failure row,
    /// never a silent no-op.
    #[test]
    fn refine_session_command_refuses_without_the_daemon() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, _dir) = trigger_engine(&json!({ "responses": [] }), 1, true);
        let mut events: Vec<EngineEvent> = Vec::new();
        let execution = crate::session_commands::run_session_command(
            &engine,
            &refine_command(),
            &[],
            &mut |event| {
                events.push(event);
                true
            },
        );
        assert!(execution.is_some(), "the /refine command answered");
        let result_row = events
            .iter()
            .rev()
            .find_map(|event| match event {
                EngineEvent::CustomMessage(row)
                    if row["customType"] == "session_slash_command_result" =>
                {
                    Some(row.clone())
                }
                _ => None,
            })
            .expect("the failure row");
        assert_eq!(result_row["details"]["success"], json!(false));
        assert!(
            result_row["content"]
                .as_str()
                .unwrap_or_default()
                .contains("daemon-backed"),
            "the refusal names the gate: {result_row}"
        );
        assert!(
            events
                .iter()
                .all(|event| !matches!(event, EngineEvent::RefineComplete { .. })),
            "no completion without the daemon: {events:?}"
        );
    }

    fn refine_command() -> pa_core::session_engine::slash_commands::SessionSlashCommand {
        use pa_core::session_engine::slash_commands::{
            parse_session_command, SlashCommandRegistry,
        };
        parse_session_command(&SlashCommandRegistry::builtin(), "/refine")
            .expect("the test text is a session command")
    }
}
