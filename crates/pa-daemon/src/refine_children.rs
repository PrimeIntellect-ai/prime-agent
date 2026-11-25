//! The refinement-child orchestration on the daemon engine: the
//! fire-and-wake flow. `/refine` spawns one refinement child (the
//! `RlmSpawnKind::Refine` spawn, `runtimeMetadata.kind = "refine"` on its
//! durable create) with the prepared planning request and returns
//! immediately — the session lock and the compaction flight are never held.
//! Refinements may overlap, as in the in-process pipeline: each child has
//! its own flight, keyed by the child's active session id. The child's
//! reply lands as the standard child-reply notification, the delivery is
//! answered at once (the child's send never waits on the parent's apply),
//! and the parked reply commits at the session's idle boundary through the
//! same `commit_refinement` the in-process pipeline uses. A child that ends
//! without replying hands its end to the engine through the registry's
//! refine terminal hook and parks a failure in the reply's place, so it
//! fails the refinement on the same apply path. The child's registry record
//! retires at its own settle, so the one-shot child never orphans in the
//! roster.

use std::sync::{Arc, PoisonError};

use anyhow::{anyhow, bail, Context as _};

use pa_core::session_engine::refine::{
    CommittedRefinement, PreparedRefinement, RefineOptions, RefinementSource,
};
use pa_core::session_engine::rlm_host::{RlmSpawnKind, RlmSpawnRequest, RlmSubagentHost};

use crate::agent_engine::AgentSessionEngine;
use crate::rlm_children::SupervisorChildSessions;

/// One refinement child in flight: what the parent captured before the
/// child's model pass.
pub(crate) struct RefineChildFlight {
    pub rlm_child_id: String,
    pub prepared: PreparedRefinement,
    pub source: RefinementSource,
}

/// The parked reply of one refinement child, applied at the session's idle
/// boundary.
pub(crate) struct PendingRefineReply {
    pub flight: RefineChildFlight,
    pub reply: String,
}

impl AgentSessionEngine {
    /// Spawn a refinement child (fire) and return its id once it is
    /// admitted; its reply applies on arrival.
    ///
    /// # Errors
    ///
    /// Returns an error when refinements are disabled, the session has no
    /// child runtime, or the spawn admission fails.
    pub(crate) async fn spawn_refine_child(
        &self,
        options: &RefineOptions,
        source: RefinementSource,
    ) -> anyhow::Result<String> {
        let children = self.children.as_ref().ok_or_else(|| {
            anyhow!("the refine command requires a daemon-backed session: this session has no RLM child runtime")
        })?;
        self.admit_refine_child(children, options, source).await
    }

    /// A branch move or a replacement teardown abandons the conversation
    /// the refinement children plan on: their flights and parked replies
    /// drop, then the children are cancelled, so no proposal applies to the
    /// moved-to conversation and a cancelled child has no flight left to
    /// fail. The cancel cannot recall a reply that is already in delivery:
    /// each abandoned child's id is recorded until that late reply arrives,
    /// so the park drops it and it never lands as an agent message.
    pub(crate) async fn abandon_refine_children(&self) {
        // Under the spawn lock, no admission sits between its prepare and
        // its flight's record, so every live child is in the map.
        let _spawn = self.refine_spawn_lock.lock().await;
        let running: Vec<String> = {
            let mut flights = self
                .refine_flights
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let mut abandoned = self
                .abandoned_refine_children
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            self.pending_refine_replies
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clear();
            flights
                .drain()
                .map(|(active_session_id, flight)| {
                    abandoned.insert(active_session_id);
                    flight.rlm_child_id
                })
                .collect()
        };
        if let Some(children) = self.children.as_ref() {
            for rlm_child_id in &running {
                children.cancel_child_run(rlm_child_id).await;
            }
        }
    }

    /// Prepare the planning request, admit the refinement child, and record
    /// its flight before the child's task prompt is released, so its reply
    /// always finds the flight.
    pub(crate) async fn admit_refine_child(
        &self,
        children: &Arc<SupervisorChildSessions>,
        options: &RefineOptions,
        source: RefinementSource,
    ) -> anyhow::Result<String> {
        // The spawn lock orders the whole admission against an abandon: a
        // branch move either sees this child's flight or runs before its
        // prepare reads the conversation.
        let _spawn = self.refine_spawn_lock.lock().await;
        let model = self.session_model()?;
        self.ensure_core_session_async(&model).await?;
        let core = {
            let guard = self.session.lock().await;
            guard.clone()
        };
        let Some(core) = core else {
            bail!("the refinement child requires a built session");
        };
        let (prepared, prompt) = core.session.prepare_refinement(options, &model).await?;
        // The standard spawn semantics: the model and thinking default to
        // the session's. A refine child's task prompt stays held until the
        // release below.
        let handle = children
            .spawn(RlmSpawnRequest {
                prompt,
                name: None,
                model: None,
                thinking: None,
                kind: RlmSpawnKind::Refine,
                cwd: None,
                spawned_by_request_id: None,
                factory: None,
            })
            .await
            .context("the refinement child spawn failed")?;
        let rlm_child_id = handle.rlm_child_id;
        let active_session_id = children
            .child_identities()
            .await
            .into_iter()
            .find(|identity| identity.rlm_child_id == rlm_child_id)
            .map(|identity| identity.active_session_id)
            .ok_or_else(|| anyhow!("the refinement child admitted without a registry identity"))?;
        self.refine_flights
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(
                active_session_id,
                RefineChildFlight {
                    rlm_child_id: rlm_child_id.clone(),
                    prepared,
                    source,
                },
            );
        // The planning pass bills on the parent's totals: register the
        // spawn with the usage attribution (the kernel path's own
        // `register_spawn`), so the child's answer-row usage folds in at
        // its settle.
        self.register_refine_child_usage(&rlm_child_id).await;
        children.release_child_prompt(&rlm_child_id).await;
        Ok(rlm_child_id)
    }

    /// The wake's first half: park a refinement child's reply for the
    /// idle-boundary apply; the delivery is answered at once. The late reply
    /// of a child that a branch move or a replacement abandoned, or whose
    /// refinement already failed, is consumed and dropped. `None` for any
    /// other sender.
    pub(crate) fn park_refine_child_reply(
        &self,
        sender_active_session_id: &str,
        message: &str,
    ) -> Option<()> {
        // One flights-lock scope across the whole park: an abandon (which
        // drains the flights and clears the parked replies under the same
        // lock) either sees this reply parked or this park sees the
        // abandoned id.
        let mut flights = self
            .refine_flights
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let Some(flight) = flights.remove(sender_active_session_id) else {
            return self
                .abandoned_refine_children
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(sender_active_session_id)
                .then_some(());
        };
        self.pending_refine_replies
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(PendingRefineReply {
                flight,
                reply: message.to_string(),
            });
        Some(())
    }

    /// Route the registry's refinement-child terminal outcomes here: a
    /// child that ends without replying parks its refinement's failure, and
    /// the runner wakes for the idle-boundary apply, as a parked reply
    /// wakes it.
    pub(crate) fn wire_refine_child_terminal(
        self: &Arc<Self>,
        work_notify: Arc<crate::worker::WorkNotify>,
    ) {
        let Some(children) = self.children.as_ref() else {
            return;
        };
        let weak = Arc::downgrade(self);
        children.set_refine_terminal_hook(Arc::new(move |active_session_id, error| {
            if weak
                .upgrade()
                .is_some_and(|engine| engine.park_refine_child_failure(active_session_id, error))
            {
                work_notify.notify_one();
            }
        }));
    }

    /// A refinement child ended (its worker died or became unreachable, its
    /// run failed or ended, a delete cancelled it): when its flight is still
    /// open, the child never replied, so its failure parks in the reply's
    /// place — the idle-boundary apply fails the refinement and finishes the
    /// compact round it carried, and a late reply from the child is
    /// dropped. `false` when no flight is open (the child replied, or a
    /// branch move abandoned it): nothing is owed.
    pub(crate) fn park_refine_child_failure(
        &self,
        active_session_id: &str,
        error: Option<&str>,
    ) -> bool {
        let mut flights = self
            .refine_flights
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let Some(flight) = flights.remove(active_session_id) else {
            return false;
        };
        // A cancelled child's planning call can still finish and send its
        // reply: the park drops it like an abandoned child's late reply.
        self.abandoned_refine_children
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(active_session_id.to_string());
        let error = match error {
            Some(error) => format!("the refinement child ended before replying: {error}"),
            None => "the refinement child ended without replying".to_string(),
        };
        self.pending_refine_replies
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(PendingRefineReply {
                flight,
                reply: serde_json::json!({
                    "type": crate::refine_engine::REFINEMENT_ERROR_REPLY_TYPE,
                    "error": error,
                })
                .to_string(),
            });
        true
    }

    /// The wake's second half: apply the oldest parked reply at the
    /// session's idle boundary. `None` when nothing is parked.
    pub(crate) async fn apply_pending_refine_reply(
        &self,
    ) -> Option<anyhow::Result<CommittedRefinement>> {
        if self
            .pending_refine_replies
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_empty()
        {
            return None;
        }
        // Under the spawn lock, an abandon either finishes first (and drops
        // the parked reply) or waits until this apply landed.
        let _spawn = self.refine_spawn_lock.lock().await;
        let pending = {
            let mut pending = self
                .pending_refine_replies
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            (!pending.is_empty()).then(|| pending.remove(0))
        }?;
        Some(
            self.apply_flight_reply(pending.flight, &pending.reply)
                .await,
        )
    }

    /// Commit one refinement child's reply, then finish the compact-trigger
    /// round the child carried — on every outcome, so no round stays in
    /// flight.
    async fn apply_flight_reply(
        &self,
        flight: RefineChildFlight,
        reply: &str,
    ) -> anyhow::Result<CommittedRefinement> {
        let RefineChildFlight {
            prepared, source, ..
        } = flight;
        let core = {
            let guard = self.session.lock().await;
            guard.clone()
        };
        let Some(core) = core else {
            bail!("the refinement reply arrived without a built session");
        };
        let result = match serde_json::from_str::<serde_json::Value>(reply) {
            // The child's own failure answered with the tagged error envelope.
            Ok(value)
                if value.get("type").and_then(serde_json::Value::as_str)
                    == Some(crate::refine_engine::REFINEMENT_ERROR_REPLY_TYPE) =>
            {
                let error = value
                    .get("error")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("the refinement child failed");
                Err(anyhow!("Refinement failed: {error}"))
            }
            parsed => match parsed.and_then(serde_json::from_value) {
                Ok(message) => {
                    core.session
                        .apply_child_refinement(prepared, &message, source)
                        .await
                }
                Err(error) => Err(anyhow!(
                    "Refinement failed: unreadable child reply: {error}"
                )),
            },
        };
        if source == RefinementSource::Auto {
            core.session.finish_compact_auto_refine_round();
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_engine::tests::admit;
    use crate::agent_engine::FAUX_TEST_LOCK;
    use crate::engine::SessionEngine as _;
    use pa_types::ai::{AssistantContentBlock, AssistantMessage, StopReason, TextContent};
    use serde_json::json;

    /// The child's reply: the planning model reply carrying one local
    /// memory create.
    fn proposal_reply() -> String {
        serde_json::to_string(&AssistantMessage {
            content: vec![AssistantContentBlock::Text(TextContent {
                text: r#"{"summary":"tactic","rationale":"the seed turn repeats a tactic","expectedOutcome":"recall","edits":[{"action":"create","kind":"memory","id":"m1","title":"Tactic","content":"Use tactic A"}]}"#.to_string(),
                text_signature: None,
                rest: serde_json::Map::default(),
            })],
            api: "openai-completions".to_string(),
            provider: "test".to_string(),
            model: "m".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: pa_types::ai::Usage::default(),
            stop_reason: StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
            rest: serde_json::Map::default(),
        })
        .unwrap()
    }

    /// One faux engine with a built session whose local harness store lives
    /// under its temp dir.
    fn park_engine() -> (std::sync::Arc<AgentSessionEngine>, tempfile::TempDir) {
        // The engine is built here (not through the shared helper): the
        // apply's local store derives from the session dir, which the
        // helper pins to None.
        use crate::agent_engine::{AgentEngineConfig, AgentSessionEngine};
        let dir = tempfile::TempDir::new().unwrap();
        crate::agent_engine::tests::write_compaction_settings(dir.path(), 1);
        let sessions = dir.path().join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let engine = std::sync::Arc::new(
            AgentSessionEngine::new(AgentEngineConfig {
                cwd: dir.path().to_path_buf(),
                agent_dir: dir.path().join("agent"),
                provider: None,
                model: None,
                api_key: None,
                thinking: None,
                session_dir: Some(sessions.clone()),
                session_file: Some(sessions.join("park-session.jsonl")),
                faux_script: Some(json!({ "responses": [{"text": "seed reply"}] }).to_string()),
                supervisor_link: None,
                telemetry_disabled: None,
                cron_store: None,
                queued_steering_probe: None,
            })
            .unwrap(),
        );
        engine.register_arc();
        let mut events = Vec::new();
        admit(&engine, "seed turn".to_string(), &mut events);
        (engine, dir)
    }

    /// Record one flight the way the admission records it: the real
    /// prepare over the engine's built session.
    fn park_flight(engine: &AgentSessionEngine, active_session_id: &str) {
        let model = engine.session_model().unwrap();
        let core = engine.session.blocking_lock().clone().unwrap();
        let (prepared, _prompt) = engine
            .runtime
            .block_on(
                core.session
                    .prepare_refinement(&RefineOptions::default(), &model),
            )
            .unwrap();
        engine
            .refine_flights
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(
                active_session_id.to_string(),
                RefineChildFlight {
                    rlm_child_id: format!("rlm-{active_session_id}"),
                    prepared,
                    source: RefinementSource::User,
                },
            );
    }

    fn pending_count(engine: &AgentSessionEngine) -> usize {
        engine
            .pending_refine_replies
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }

    fn flight_count(engine: &AgentSessionEngine) -> usize {
        engine
            .refine_flights
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }

    fn local_harness_state(dir: &std::path::Path) -> serde_json::Value {
        // The apply writes the session's own artifact store — the one the
        // conversation log implies (main's digest context), never a shared
        // sessions/harness file.
        let log = dir.join("sessions").join("park-session.jsonl");
        let Some(store) = pa_core::session_engine::harness_digest::local_harness_dir_for_log(&log)
        else {
            return serde_json::Value::Null;
        };
        let path = pa_core::refinement::get_harness_state_path(&store);
        std::fs::read_to_string(&path).map_or(serde_json::Value::Null, |content| {
            serde_json::from_str(&content).expect("harness state parses")
        })
    }

    /// The wake parks the child's reply instead of applying inside the
    /// delivery: the flight moves into the parked queue, and nothing touches
    /// the harness store yet. A sender that is not an in-flight child never
    /// parks. Red when the park call applies, or when the flight survives a
    /// parked reply.
    #[test]
    fn a_reply_parks_without_applying() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, dir) = park_engine();
        park_flight(&engine, "active-1");
        assert!(
            engine
                .park_refine_child_reply("active-2", &proposal_reply())
                .is_none(),
            "a foreign sender never parks"
        );
        assert_eq!(
            flight_count(&engine),
            1,
            "the flight survived the foreign reply"
        );
        assert_eq!(
            engine.park_refine_child_reply("active-1", &proposal_reply()),
            Some(()),
            "the child's reply parks"
        );
        assert_eq!(flight_count(&engine), 0, "the flight consumed");
        assert_eq!(pending_count(&engine), 1, "the reply parked");
        assert_eq!(
            local_harness_state(dir.path()),
            serde_json::Value::Null,
            "the park never applied: no harness state was written"
        );
    }

    /// Two refinements overlap: both children's replies park, and the idle
    /// apply commits each one once, in arrival order, through the shared
    /// commit (the second sees the first's entry through the stale check).
    /// Red when a second flight is refused or replaces the first, or when a
    /// parked reply applies twice.
    #[test]
    fn overlapping_refinements_each_apply_once() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, dir) = park_engine();
        park_flight(&engine, "active-1");
        park_flight(&engine, "active-2");
        assert_eq!(flight_count(&engine), 2, "both refinements are in flight");
        assert_eq!(
            engine.park_refine_child_reply("active-2", &proposal_reply()),
            Some(())
        );
        assert_eq!(
            engine.park_refine_child_reply("active-1", &proposal_reply()),
            Some(())
        );
        let apply = || {
            engine
                .runtime
                .block_on(async { engine.apply_pending_refine_reply().await })
        };
        let first = apply().expect("a parked reply").expect("the first apply");
        assert!(first.result.applied_edits[0].applied);
        assert!(
            first
                .rows
                .iter()
                .any(|row| row.custom_type == "refinement_notice"),
            "the commit returns the notice row the worker emits"
        );
        let state = local_harness_state(dir.path());
        assert_eq!(
            state["entries"]["memory"]["m1"]["title"], "Tactic",
            "the applied harness state: {state}"
        );
        assert!(apply().is_some(), "the second parked reply applies too");
        assert_eq!(pending_count(&engine), 0, "the parked queue drained");
        assert!(apply().is_none(), "each reply applies once");
    }

    /// A child that ends without replying fails its refinement on the reply
    /// path: its failure parks in the flight's place and the idle apply
    /// answers the failure with the child's reason; a child with no open
    /// flight (it replied) owes nothing, and a late reply is dropped. Red
    /// when the failure is dropped, the flight survives the child's end, or
    /// the late reply parks.
    #[test]
    fn a_child_that_ends_without_replying_fails_its_refinement() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, dir) = park_engine();
        park_flight(&engine, "active-1");
        assert!(engine.park_refine_child_failure("active-1", Some("Child worker unreachable")));
        assert_eq!(
            flight_count(&engine),
            0,
            "the child's end released its flight"
        );
        assert!(
            !engine.park_refine_child_failure("active-1", None),
            "a child without an open flight owes nothing"
        );
        assert_eq!(
            engine.park_refine_child_reply("active-1", &proposal_reply()),
            Some(()),
            "the failed child's late reply is consumed, not delivered as an agent message"
        );
        assert_eq!(pending_count(&engine), 1, "only the failure is parked");
        let error = engine
            .runtime
            .block_on(async { engine.apply_pending_refine_reply().await })
            .expect("the parked failure applies")
            .expect_err("the refinement fails");
        assert!(
            error.to_string().contains("Child worker unreachable"),
            "the failure names the child's reason: {error}"
        );
        assert_eq!(pending_count(&engine), 0);
        assert_eq!(
            local_harness_state(dir.path()),
            serde_json::Value::Null,
            "nothing reached the harness store"
        );
    }

    /// A branch move and a replacement teardown abandon the conversation
    /// the refinement children planned on: the move drops the in-flight
    /// flights, and the teardown drops a reply parked before it, so nothing
    /// applies to the moved-to conversation. The late reply (already in
    /// delivery when the cancel ran) of every abandoned child is consumed
    /// without a park, so it never falls through to the agent-message path,
    /// and the consumed id is removed. Red when either seam keeps a flight
    /// or a parked reply, or when a late reply is not consumed.
    #[test]
    fn a_branch_move_and_a_replacement_drop_the_abandoned_refinements() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, dir) = park_engine();
        park_flight(&engine, "active-1");
        let mut moved = crate::session_store::SessionFile::create("/tmp", None, 0);
        moved.append_message(&json!({
            "role": "user",
            "content": "moved branch",
            "timestamp": 1u64,
        }));
        engine
            .rebuild_session_context(
                moved.branch_file_entries(),
                pa_core::session_engine::goal_driver::GoalBranchReload::FaithfulBranch,
            )
            .expect("the branch move");
        assert_eq!(
            flight_count(&engine),
            0,
            "the branch move dropped the flight"
        );
        park_flight(&engine, "active-2");
        assert_eq!(
            engine.park_refine_child_reply("active-2", &proposal_reply()),
            Some(())
        );
        park_flight(&engine, "active-3");
        engine.runtime.block_on(engine.teardown_for_replacement());
        assert_eq!(
            pending_count(&engine),
            0,
            "the teardown dropped the parked reply"
        );
        assert_eq!(flight_count(&engine), 0, "the teardown dropped the flight");
        assert!(
            engine
                .runtime
                .block_on(async { engine.apply_pending_refine_reply().await })
                .is_none(),
            "nothing is left to apply"
        );
        assert_eq!(
            local_harness_state(dir.path()),
            serde_json::Value::Null,
            "no abandoned proposal reached the harness store"
        );
        for sender in ["active-1", "active-3"] {
            assert_eq!(
                engine.park_refine_child_reply(sender, &proposal_reply()),
                Some(()),
                "the late reply of the abandoned child {sender} is consumed, not delivered as an agent message"
            );
        }
        assert_eq!(pending_count(&engine), 0, "no late reply parks");
        assert!(
            engine
                .park_refine_child_reply("active-1", &proposal_reply())
                .is_none(),
            "the consumed late reply removed its id"
        );
    }
}
