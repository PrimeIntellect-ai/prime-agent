//! The compact-trigger auto-refine scheduling (TS `_scheduleAutoRefineAfterCompaction`, armed
//! after every successful compaction): the daemon worker services the trigger off each turn's
//! settle in a background task — the round is the refinement child's spawn (fire-and-wake;
//! the child's proposal applies on its reply's arrival). ACP consumes it at the serialized
//! checkpoint between turns.

use pa_core::session_engine::auto_refine_trigger::CompactAutoRefineSurface;
use pa_core::session_engine::refine::RefinementSource;

use crate::agent_engine::AgentSessionEngine;

impl AgentSessionEngine {
    pub(crate) fn report_background_refinement(
        &self,
        pending: tokio::task::JoinHandle<
            anyhow::Result<pa_core::session_engine::refine::CommittedRefinement>,
        >,
    ) {
        let sink = self.refinement_completion_sink.lock().unwrap().clone();
        if let Some(sink) = sink {
            sink(pending);
        } else {
            // Non-worker hosts can omit the stream sink; durable core rows still
            // persist. Observe errors instead of silently discarding the task.
            self.runtime.spawn(async move {
                match pending.await {
                    Ok(Ok(_)) => {}
                    Ok(Err(error)) => eprintln!("pa-daemon: refinement failed: {error:#}"),
                    Err(error) => eprintln!("pa-daemon: refinement task failed: {error}"),
                }
            });
        }
    }

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

    /// Arm the test seam that fires when the round body is about to wait
    /// for the spawn lock.
    #[cfg(test)]
    pub(crate) fn set_refine_spawn_lock_wait_probe(
        &self,
        probe: Option<std::sync::Arc<dyn Fn() + Send + Sync>>,
    ) {
        *self
            .refine_spawn_lock_wait_probe
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = probe;
    }

    /// The shared round body (the `compact` command path and the turn
    /// settle both run it): the pending pre-check, the TS busy gates, the
    /// pa-core round take, then the refinement child's spawn. The gates
    /// (enabled, compact, cooldown, the in-flight guard) live on the
    /// session's trigger state; the review gate is gone — the child's own
    /// empty-edits judgment is the gate. The take and the spawn ride one
    /// admission under the spawn lock, so a concurrent manual `/refine`
    /// cannot consume the armed trigger between them. `Ok(())` is every
    /// silent outcome; the spawn's errors surface.
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
        let children = self.children.clone();
        let core = {
            let guard = self.session.blocking_lock();
            guard.clone()
        };
        let Some(core) = core else {
            return Ok(());
        };
        // The whole admission rides ONE async section under the spawn lock:
        // the dead-round release, the lane check, the round take, and the
        // spawn. A concurrent manual `/refine` can no longer slip between
        // the take and the spawn — that window consumed the armed trigger
        // and surfaced a spurious `refine_failed`. A live refinement child
        // (a manual spawn whose reply has not landed, or whose reply is
        // parked for the idle apply) keeps the trigger armed for a later
        // boundary.
        let outcome = self.runtime.block_on(async {
            #[cfg(test)]
            let wait_probe = self
                .refine_spawn_lock_wait_probe
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            #[cfg(test)]
            if let Some(probe) = wait_probe {
                probe();
            }
            let _spawn = self.refine_spawn_lock.lock().await;
            self.release_dead_refine_child_round().await;
            {
                let flight = self
                    .refine_flight
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let pending = self
                    .pending_refine_reply
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if flight.is_some() || pending.is_some() {
                    return Ok(());
                }
            }
            // The round take: the gates decide and stamp the cadence; the
            // in-flight guard holds the trigger while the child runs.
            let options = core
                .session
                .take_compact_auto_refine_round(CompactAutoRefineSurface::Checkpoint);
            let Some(options) = options else {
                return Ok(());
            };
            // Fire: the spawn returns once the child is admitted; the
            // child's proposal applies on its reply's arrival (the wake
            // finishes the round either way). A standalone engine refuses
            // visibly here, exactly as before the take moved under the
            // lock: the taken round is released below.
            let Some(children) = children.as_ref() else {
                anyhow::bail!(
                    "The refine command requires a daemon-backed session: the refinement child is a spawned session, and this session has no RLM child runtime."
                );
            };
            self.spawn_refine_child_inner(children, &options, RefinementSource::Auto)
                .await
                .map(|_| ())
        });
        if let Err(error) = outcome {
            // A failed spawn releases the round here — its error surfaced,
            // so the next armed trigger is not wedged behind the
            // in-flight guard.
            core.session.finish_compact_auto_refine_round();
            return Err(error);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::agent_engine::tests::{admit, faux_engine_with_settings};
    use crate::agent_engine::{AgentSessionEngine, FAUX_TEST_LOCK};
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
    ) -> (std::sync::Arc<AgentSessionEngine>, tempfile::TempDir) {
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
                    in_flight: pa_core::session_engine::refine::RefinementFlightGuard::enter(
                        std::sync::Arc::default(),
                    ),
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

    /// The take rides the spawn lock: while a manual `/refine` admission
    /// holds the lock, the armed round is not consumed. The old order took
    /// the round first, so a racing manual child made the auto spawn fail
    /// after the trigger was already gone — a lost round plus a spurious
    /// `refine_failed`. Red when the take moves back out of the lock.
    #[test]
    fn the_armed_round_is_taken_only_under_the_spawn_lock() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, _dir) =
            trigger_engine(&json!({ "responses": [ {"text": "seed reply"} ] }), 1, true);
        let mut events: Vec<EngineEvent> = Vec::new();
        admit(&engine, "seed turn".to_string(), &mut events);
        engine.mark_compact_auto_refine_pending();
        // The manual admission owns the lane: the spawn lock is held.
        let held = engine
            .runtime
            .block_on(async { engine.refine_spawn_lock.lock().await });
        // Readiness is the consumer's own signal from the spawn-lock wait,
        // not a fixed sleep: the held lock pins the take until the drop.
        let (waiting_tx, waiting_rx) = std::sync::mpsc::channel();
        engine.set_refine_spawn_lock_wait_probe(Some(std::sync::Arc::new(move || {
            let _ = waiting_tx.send(());
        })));
        std::thread::scope(|scope| {
            let consuming = scope.spawn(|| engine.consume_compact_auto_refine_round());
            waiting_rx
                .recv_timeout(std::time::Duration::from_secs(2))
                .expect("the consumer reached the spawn lock");
            assert!(
                engine.compact_auto_refine_pending(),
                "the armed round must not be consumed while the spawn lock is held"
            );
            drop(held);
            let outcome = consuming.join().expect("the consuming thread");
            // The standalone engine still takes and refuses after the lock
            // releases, and the refusal releases the round (the unchanged
            // contract).
            assert!(
                outcome.is_err(),
                "the standalone engine still refuses visibly: {outcome:?}"
            );
        });
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
