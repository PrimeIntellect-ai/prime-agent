//! The refinement-child orchestration on the daemon engine: the
//! fire-and-wake flow. `/refine` spawns one refinement child (the
//! `RlmSpawnKind::Refine` spawn, `runtimeMetadata.kind = "refine"` on its
//! durable create) with the prepared planning task and returns
//! immediately — the session lock and the compaction flight are never held.
//! The child is an agent session with the normal tool surface; its final
//! message is the proposal. Refinements may overlap: each child has its own
//! flight, keyed by the child's active session id. When the child settles,
//! the registry hands its outcome to the engine through the refine terminal
//! hook (no notice reaches the conversation), and the parked outcome commits
//! at the session's idle boundary through the same `commit_refinement` the
//! in-process pipeline uses. The child's registry record retires at its own
//! settle, so the one-shot child never orphans in the roster.

use std::sync::{Arc, PoisonError};

use anyhow::{anyhow, bail, Context as _};

use pa_core::session_engine::refine::{
    CommittedRefinement, PreparedRefinement, RefineOptions, RefinementSource,
};
use pa_core::session_engine::rlm_host::{RlmSpawnKind, RlmSpawnRequest, RlmSubagentHost};

use crate::agent_engine::AgentSessionEngine;
use crate::rlm_children::{RefineChildOutcome, SupervisorChildSessions};

/// One refinement child in flight: what the parent captured before the
/// child's run.
pub(crate) struct RefineChildFlight {
    pub rlm_child_id: String,
    pub prepared: PreparedRefinement,
    pub source: RefinementSource,
}

/// One settled refinement child's outcome, applied at the session's idle
/// boundary.
pub(crate) struct PendingRefineOutcome {
    pub flight: RefineChildFlight,
    pub outcome: RefineChildOutcome,
}

impl AgentSessionEngine {
    /// Spawn a refinement child (fire) and return its id once it is
    /// admitted; its proposal applies when it settles.
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
    /// the refinement children plan on: their flights and parked outcomes
    /// drop, then the children are cancelled, so no proposal applies to the
    /// moved-to conversation and a cancelled child's settle finds no flight.
    pub(crate) async fn abandon_refine_children(&self) {
        // Under the spawn lock, no admission sits between its prepare and
        // its flight's record, so every live child is in the map.
        let _spawn = self.refine_spawn_lock.lock().await;
        let running: Vec<String> = {
            let mut flights = self
                .refine_flights
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            self.pending_refine_outcomes
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clear();
            flights
                .drain()
                .map(|(_, flight)| flight.rlm_child_id)
                .collect()
        };
        if let Some(children) = self.children.as_ref() {
            for rlm_child_id in &running {
                children.cancel_child_run(rlm_child_id).await;
            }
        }
    }

    /// Prepare the planning task, admit the refinement child, and record
    /// its flight before the child's task prompt is released, so its settle
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
        children.release_child_prompt(&rlm_child_id).await;
        Ok(rlm_child_id)
    }

    /// Route the registry's refinement-child terminal outcomes here: the
    /// settled child's outcome parks, and the runner wakes for the
    /// idle-boundary apply.
    pub(crate) fn wire_refine_child_terminal(
        self: &Arc<Self>,
        work_notify: Arc<crate::worker::WorkNotify>,
    ) {
        let Some(children) = self.children.as_ref() else {
            return;
        };
        let weak = Arc::downgrade(self);
        children.set_refine_terminal_hook(Arc::new(move |active_session_id, outcome| {
            if weak
                .upgrade()
                .is_some_and(|engine| engine.park_refine_child_outcome(active_session_id, outcome))
            {
                work_notify.notify_one();
            }
        }));
    }

    /// A refinement child settled: when its flight is still open, its
    /// outcome parks for the idle-boundary apply, which commits the
    /// proposal or fails the refinement and finishes the compact round it
    /// carried. `false` when no flight is open (a branch move abandoned
    /// it): nothing is owed.
    pub(crate) fn park_refine_child_outcome(
        &self,
        active_session_id: &str,
        outcome: RefineChildOutcome,
    ) -> bool {
        let mut flights = self
            .refine_flights
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let Some(flight) = flights.remove(active_session_id) else {
            return false;
        };
        self.pending_refine_outcomes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(PendingRefineOutcome { flight, outcome });
        true
    }

    /// Apply the oldest parked outcome at the session's idle boundary,
    /// with its flight's source. `None` when nothing is parked.
    pub(crate) async fn apply_pending_refine_outcome(
        &self,
    ) -> Option<(RefinementSource, anyhow::Result<CommittedRefinement>)> {
        if self
            .pending_refine_outcomes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_empty()
        {
            return None;
        }
        // Under the spawn lock, an abandon either finishes first (and drops
        // the parked outcome) or waits until this apply landed.
        let _spawn = self.refine_spawn_lock.lock().await;
        let pending = {
            let mut pending = self
                .pending_refine_outcomes
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            (!pending.is_empty()).then(|| pending.remove(0))
        }?;
        let source = pending.flight.source;
        Some((source, self.apply_flight_outcome(pending).await))
    }

    /// Commit one refinement child's proposal, then finish the
    /// compact-trigger round the child carried — on every outcome, so no
    /// round stays in flight.
    async fn apply_flight_outcome(
        &self,
        pending: PendingRefineOutcome,
    ) -> anyhow::Result<CommittedRefinement> {
        let PendingRefineOutcome {
            flight: RefineChildFlight {
                prepared, source, ..
            },
            outcome,
        } = pending;
        let core = {
            let guard = self.session.lock().await;
            guard.clone()
        };
        let Some(core) = core else {
            bail!("the refinement child settled without a built session");
        };
        let result = match outcome {
            RefineChildOutcome::Answered(answer) => {
                core.session
                    .apply_child_refinement(prepared, &answer, source)
                    .await
            }
            RefineChildOutcome::Failed(Some(reason)) => Err(anyhow!(
                "Refinement failed: the refinement child ended without a proposal: {reason}"
            )),
            RefineChildOutcome::Failed(None) => Err(anyhow!(
                "Refinement failed: the refinement child ended without a proposal"
            )),
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
    use serde_json::json;

    /// The child's settle: its final message carrying one local memory
    /// create.
    fn proposal() -> RefineChildOutcome {
        RefineChildOutcome::Answered(r#"{"summary":"tactic","rationale":"the seed turn repeats a tactic","expectedOutcome":"recall","edits":[{"action":"create","kind":"memory","id":"m1","title":"Tactic","content":"Use tactic A"}]}"#.to_string())
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
            .pending_refine_outcomes
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

    /// The settle parks the child's outcome instead of applying inside the
    /// registry's hook: the flight moves into the parked queue, and nothing
    /// touches the harness store yet. A child that is not in flight never
    /// parks. Red when the park call applies, or when the flight survives a
    /// parked outcome.
    #[test]
    fn a_settled_outcome_parks_without_applying() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, dir) = park_engine();
        park_flight(&engine, "active-1");
        assert!(
            !engine.park_refine_child_outcome("active-2", proposal()),
            "a child without a flight never parks"
        );
        assert_eq!(
            flight_count(&engine),
            1,
            "the flight survived the foreign outcome"
        );
        assert!(
            engine.park_refine_child_outcome("active-1", proposal()),
            "the child's outcome parks"
        );
        assert_eq!(flight_count(&engine), 0, "the flight consumed");
        assert_eq!(pending_count(&engine), 1, "the outcome parked");
        assert_eq!(
            local_harness_state(dir.path()),
            serde_json::Value::Null,
            "the park never applied: no harness state was written"
        );
    }

    /// Two refinements overlap: both children's outcomes park, and the idle
    /// apply commits each one once, in arrival order, through the shared
    /// commit (the second sees the first's entry through the stale check).
    /// Red when a second flight is refused or replaces the first, or when a
    /// parked outcome applies twice.
    #[test]
    fn overlapping_refinements_each_apply_once() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, dir) = park_engine();
        park_flight(&engine, "active-1");
        park_flight(&engine, "active-2");
        assert_eq!(flight_count(&engine), 2, "both refinements are in flight");
        assert!(engine.park_refine_child_outcome("active-2", proposal()));
        assert!(engine.park_refine_child_outcome("active-1", proposal()));
        let apply = || {
            engine
                .runtime
                .block_on(async { engine.apply_pending_refine_outcome().await })
        };
        let (_, first) = apply().expect("a parked outcome");
        let first = first.expect("the first apply");
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
        assert!(apply().is_some(), "the second parked outcome applies too");
        assert_eq!(pending_count(&engine), 0, "the parked queue drained");
        assert!(apply().is_none(), "each outcome applies once");
    }

    /// A child that ends without a proposal fails its refinement on the
    /// same apply path: its failure parks in the flight's place and the idle
    /// apply answers the failure with the child's reason and its flight's
    /// source; a child with no open flight owes nothing. Red when the
    /// failure is dropped or the flight survives the child's end.
    #[test]
    fn a_child_that_ends_without_a_proposal_fails_its_refinement() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, dir) = park_engine();
        park_flight(&engine, "active-1");
        assert!(engine.park_refine_child_outcome(
            "active-1",
            RefineChildOutcome::Failed(Some("Child worker unreachable".to_string()))
        ));
        assert_eq!(
            flight_count(&engine),
            0,
            "the child's end released its flight"
        );
        assert!(
            !engine.park_refine_child_outcome("active-1", RefineChildOutcome::Failed(None)),
            "a child without an open flight owes nothing"
        );
        let (source, outcome) = engine
            .runtime
            .block_on(async { engine.apply_pending_refine_outcome().await })
            .expect("the parked failure applies");
        assert_eq!(
            source,
            RefinementSource::User,
            "the failure reports its flight's source"
        );
        let error = outcome.expect_err("the refinement fails");
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
    /// flights, and the teardown drops an outcome parked before it, so
    /// nothing applies to the moved-to conversation, and the abandoned
    /// children's later settles park nothing. Red when either seam keeps a
    /// flight or a parked outcome.
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
        assert!(engine.park_refine_child_outcome("active-2", proposal()));
        park_flight(&engine, "active-3");
        engine.runtime.block_on(engine.teardown_for_replacement());
        assert_eq!(
            pending_count(&engine),
            0,
            "the teardown dropped the parked outcome"
        );
        assert_eq!(flight_count(&engine), 0, "the teardown dropped the flight");
        assert!(
            engine
                .runtime
                .block_on(async { engine.apply_pending_refine_outcome().await })
                .is_none(),
            "nothing is left to apply"
        );
        assert_eq!(
            local_harness_state(dir.path()),
            serde_json::Value::Null,
            "no abandoned proposal reached the harness store"
        );
        for child in ["active-1", "active-3"] {
            assert!(
                !engine.park_refine_child_outcome(child, proposal()),
                "the abandoned child {child}'s settle parks nothing"
            );
        }
        assert_eq!(pending_count(&engine), 0, "no abandoned outcome parks");
    }
}
