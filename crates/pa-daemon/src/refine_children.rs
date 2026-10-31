//! The refinement-child orchestration on the daemon engine: the
//! fire-and-wake flow. `/refine` spawns one `rlm.spawn kind="refine"` child
//! with the prepared request and returns immediately — the session lock
//! and the compaction flight are never held; the child's proposal lands as
//! the standard child-reply notification, the delivery is answered at once
//! (the child's send never waits on the parent's apply), and the parked
//! reply applies at the session's idle boundary — the runner owns turn
//! admission, so the apply's rows never interleave with a running turn's
//! history. The apply re-reads the harness state fresh, records the
//! refinement event, and tears the child down.

use std::path::PathBuf;
use std::sync::{Arc, PoisonError};

use anyhow::{anyhow, bail, Context as _};

use pa_core::refinement::RefinementResult;
use pa_core::session_engine::refine::{PreparedRefinement, RefineOptions, RefinementSource};
use pa_core::session_engine::rlm_host::{RlmSpawnRequest, RlmSubagentHost};

use crate::agent_engine::AgentSessionEngine;
use crate::rlm_children::SupervisorChildSessions;

/// One refinement child in flight: what the parent captured before the
/// child's model pass, keyed by the child's ids for the reply match.
pub(crate) struct RefineChildFlight {
    pub rlm_child_id: String,
    pub active_session_id: String,
    pub prepared: PreparedRefinement,
    pub source: RefinementSource,
    pub global_harness_dir: PathBuf,
}

/// The parked reply of one refinement child: the proposal (or the failure
/// envelope) captured at the delivery, applied at the session's idle
/// boundary.
pub(crate) struct PendingRefineReply {
    pub flight: RefineChildFlight,
    pub reply: String,
}

/// How long the settle teardown keeps waiting for the child to settle
/// before giving up (the delete refuses a still-running child).
const REFINEMENT_TEARDOWN_SLICES: u32 = 300;
const REFINEMENT_TEARDOWN_SLICE_MS: u64 = 2_000;

impl AgentSessionEngine {
    /// Spawn the refinement child (fire): prepare the request, admit one
    /// `rlm.spawn kind="refine"` child with it, and return once the child
    /// is admitted — the child's proposal applies on its reply's arrival.
    ///
    /// # Errors
    ///
    /// Returns an error when refinements are disabled, the session has no
    /// child runtime, a refinement child is already in flight, or the
    /// spawn admission fails.
    pub(crate) async fn spawn_refine_child(
        &self,
        options: &RefineOptions,
        source: RefinementSource,
    ) -> anyhow::Result<String> {
        let children = self.children.as_ref().ok_or_else(|| {
            anyhow!("the refine command requires a daemon-backed session: this session has no RLM child runtime")
        })?;
        // One refinement child at a time, admitted atomically: the spawn
        // lock holds the dead-round release, the in-flight check, the
        // prepare, and the flight's record as one admission, so the manual
        // and the auto spawn cannot both pass the check and double-spawn
        // (the in-flight child's reply owns the apply). A parked reply
        // holds the same lane until its idle-boundary apply runs — a
        // second spawn would otherwise overwrite the parked cell and lose
        // the first child's only answer.
        let _spawn = self.refine_spawn_lock.lock().await;
        self.release_dead_refine_child_round().await;
        {
            let flight = self
                .refine_flight
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let pending = self
                .pending_refine_reply
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if flight.is_some() || pending.is_some() {
                bail!("a refinement child is already in flight; its reply applies on arrival");
            }
        }
        self.spawn_refine_child_inner(children, options, source)
            .await
    }

    /// A refinement child that died without replying releases its flight
    /// and the compact round it carried, so the cadence never wedges
    /// behind the in-flight guard (the wake-side teardown covers
    /// replying children).
    pub(crate) async fn release_dead_refine_child_round(&self) {
        let Some(children) = self.children.clone() else {
            return;
        };
        // The candidate flight's ids, taken under the lock; the liveness
        // probe then awaits without holding the mutex.
        let candidate = {
            let flight = self
                .refine_flight
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            flight
                .as_ref()
                .map(|current| (current.rlm_child_id.clone(), current.source))
        };
        let Some((rlm_child_id, _)) = candidate else {
            return;
        };
        // The liveness probe: only a present, still-running record can
        // still reply. A settled run (its own failure answered, or its
        // reply lost in flight) and an absent record (deleted or
        // replaced) never can — the flight and the round release, and the
        // one-shot child's record tears down so no orphan refine child
        // lingers.
        if children.child_live(&rlm_child_id).await {
            return;
        }
        // The flight is still the probed child's: release it. A
        // concurrent spawn that replaced it in the meantime keeps its own
        // flight — the in-flight guard holds the new child.
        let finish_round = {
            let mut flight = self
                .refine_flight
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            match flight.as_ref() {
                Some(current) if current.rlm_child_id == rlm_child_id => {
                    let finish_round = current.source == RefinementSource::Auto;
                    *flight = None;
                    finish_round
                }
                _ => return,
            }
        };
        if finish_round {
            if let Some(core) = self.session.lock().await.as_deref() {
                core.session.finish_compact_auto_refine_round();
            }
        }
        self.teardown_refine_child(rlm_child_id);
    }

    /// The spawn body after the flight check: the prepare, the admission,
    /// and the flight's record.
    async fn spawn_refine_child_inner(
        &self,
        children: &Arc<SupervisorChildSessions>,
        options: &RefineOptions,
        source: RefinementSource,
    ) -> anyhow::Result<String> {
        let model = self.session_model()?;
        self.ensure_core_session_async(&model).await?;
        let global_harness_dir =
            pa_core::refinement::get_global_harness_state_dir(&self.config.agent_dir);
        let core = {
            let guard = self.session.lock().await;
            guard.clone()
        };
        let Some(core) = core else {
            bail!("the refinement child requires a built session");
        };
        // The prepare: the gate check, the trimmed conversation, and the
        // baseline captured before the child's model pass.
        let (prepared, prompt) = core
            .session
            .prepare_refinement(options, &model, &global_harness_dir)
            .await?;
        // The standard spawn semantics: the model and thinking default to
        // the session's; the kind flag makes the child run the refinement
        // protocol instead of the agent engine.
        let handle = children
            .spawn(RlmSpawnRequest {
                prompt,
                name: None,
                model: None,
                thinking: None,
                cwd: None,
                refine_child: true,
                spawned_by_request_id: None,
                factory: None,
            })
            .await
            .context("the refinement child spawn failed")?;
        let active_session_id = children
            .child_identities()
            .await
            .into_iter()
            .find(|identity| identity.rlm_child_id == handle.rlm_child_id)
            .map(|identity| identity.active_session_id)
            .ok_or_else(|| anyhow!("the refinement child admitted without a registry identity"))?;
        let rlm_child_id = handle.rlm_child_id;
        {
            let mut flight = self
                .refine_flight
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            *flight = Some(RefineChildFlight {
                rlm_child_id: rlm_child_id.clone(),
                active_session_id,
                prepared,
                source,
                global_harness_dir,
            });
        }
        Ok(rlm_child_id)
    }

    /// The wake's first half: park the refinement child's reply for the
    /// idle-boundary apply. `None` when the sender is not this session's
    /// in-flight refine child; otherwise the reply is parked and the
    /// delivery is answered at once — the child's send never waits on the
    /// parent's apply.
    pub(crate) fn park_refine_child_reply(
        &self,
        sender_active_session_id: &str,
        message: &str,
    ) -> Option<()> {
        let flight = {
            let mut flight = self
                .refine_flight
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let current = flight.as_ref()?;
            if current.active_session_id != sender_active_session_id {
                return None;
            }
            flight.take()?
        };
        *self
            .pending_refine_reply
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(PendingRefineReply {
            flight,
            reply: message.to_string(),
        });
        Some(())
    }

    /// The wake's second half: apply the parked reply at the session's
    /// idle boundary. `None` when nothing is parked; otherwise the
    /// proposal applied (`Ok`) or the refinement failed visibly (`Err`).
    pub(crate) async fn apply_pending_refine_reply(
        &self,
    ) -> Option<anyhow::Result<(RefinementResult, RefinementSource)>> {
        let pending = {
            let mut pending = self
                .pending_refine_reply
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            pending.take()?
        };
        let source = pending.flight.source;
        let outcome = self
            .apply_flight_reply(pending.flight, &pending.reply)
            .await
            .map(|result| (result, source));
        Some(outcome)
    }

    /// Apply one in-flight refine child's reply through the existing apply
    /// machinery, then finish the compact-trigger round the child carried
    /// and tear the child down — on every outcome, so no refine child
    /// orphans and no round stays in flight.
    async fn apply_flight_reply(
        &self,
        flight: RefineChildFlight,
        reply: &str,
    ) -> anyhow::Result<RefinementResult> {
        let (rlm_child_id, prepared, source, global_harness_dir) = (
            flight.rlm_child_id.clone(),
            flight.prepared,
            flight.source,
            flight.global_harness_dir.clone(),
        );
        let core = {
            let guard = self.session.lock().await;
            guard.clone()
        };
        let Some(core) = core else {
            bail!("the refinement reply arrived without a built session");
        };
        // The child's own failure answered with the tagged error envelope:
        // the refinement is never silent.
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(reply) {
            if value.get("type").and_then(serde_json::Value::as_str)
                == Some(crate::refine_engine::REFINEMENT_ERROR_REPLY_TYPE)
            {
                let error = value
                    .get("error")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("the refinement child failed");
                if source == RefinementSource::Auto {
                    core.session.finish_compact_auto_refine_round();
                }
                self.teardown_refine_child(rlm_child_id);
                // The pinned prefix (the old in-process refiner's
                // `{failure}` label): a failed model pass surfaces as
                // "Refinement failed: <reason>" on refine_failed.
                bail!("Refinement failed: {error}");
            }
        }
        // The apply re-reads the target harness state fresh and applies the
        // proposal through the stale-baseline contract.
        let result = core
            .session
            .apply_child_refinement(prepared, reply, source, &global_harness_dir)
            .await;
        if source == RefinementSource::Auto {
            core.session.finish_compact_auto_refine_round();
        }
        self.teardown_refine_child(rlm_child_id);
        result
    }

    /// The settle teardown: the refinement child is one-shot, so its reply's
    /// apply retires the child (the delete refuses a still-running child
    /// until it settles). Bounded: a wedged child surfaces through its own
    /// failure notice, and the registry's unreachable give-up settles it.
    fn teardown_refine_child(&self, rlm_child_id: String) {
        let Some(children) = self.children.clone() else {
            return;
        };
        tokio::spawn(retire_refine_child(
            children,
            rlm_child_id,
            REFINEMENT_TEARDOWN_SLICES,
            REFINEMENT_TEARDOWN_SLICE_MS,
        ));
    }
}

/// The teardown body: poll the delete until the child settles on its own.
/// A child still wedged when the window expires is killed and its record
/// retired — no refine child orphans in the registry and its slot frees.
async fn retire_refine_child(
    children: std::sync::Arc<crate::rlm_children::SupervisorChildSessions>,
    rlm_child_id: String,
    slices: u32,
    slice_ms: u64,
) {
    for _ in 0..slices {
        if matches!(
            children.delete_inactive_subagent(&rlm_child_id).await,
            Ok("deleted" | "not_found")
        ) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(slice_ms)).await;
    }
    children.cancel_child_run(&rlm_child_id).await;
    tokio::time::sleep(std::time::Duration::from_millis(slice_ms)).await;
    if !matches!(
        children.delete_inactive_subagent(&rlm_child_id).await,
        Ok("deleted" | "not_found")
    ) {
        eprintln!("pa-daemon: the refinement child {rlm_child_id} never settled for teardown");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_engine::tests::{admit, faux_engine_with_settings};
    use crate::agent_engine::FAUX_TEST_LOCK;
    use crate::engine::SessionEngine as _;
    use pa_core::refinement::{empty_harness_state, HarnessScope};
    use serde_json::json;

    /// The proposal the child answers with: one local memory create.
    const PROPOSAL: &str = r#"{"summary":"tactic","rationale":"the seed turn repeats a tactic","expectedOutcome":"recall","edits":[{"action":"create","kind":"memory","id":"m1","title":"Tactic","content":"Use tactic A"}]}"#;

    /// One faux engine with a built session whose local harness store lives
    /// under its temp dir, plus the flight fixture the wake parks.
    fn park_engine() -> (AgentSessionEngine, tempfile::TempDir) {
        let (mut engine, dir) =
            faux_engine_with_settings(&json!({ "responses": [{"text": "seed reply"}] }), 1);
        let sessions = dir.path().join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        engine.config.session_dir = Some(sessions.clone());
        engine.set_session_file(sessions.join("park-session.jsonl"));
        let mut events = Vec::new();
        admit(&engine, "seed turn".to_string(), &mut events);
        (engine, dir)
    }

    fn flight_for(dir: &std::path::Path, source: RefinementSource) -> RefineChildFlight {
        RefineChildFlight {
            rlm_child_id: "rlm-child-1".to_string(),
            active_session_id: "active-1".to_string(),
            prepared: PreparedRefinement {
                options: RefineOptions::default(),
                requested_scope: HarnessScope::Local,
                baseline_state: empty_harness_state(),
                id: "refine_1".to_string(),
            },
            source,
            global_harness_dir: dir.join("harness"),
        }
    }

    fn park_flight(engine: &AgentSessionEngine, flight: RefineChildFlight) {
        *engine
            .refine_flight
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(flight);
    }

    fn pending_some(engine: &AgentSessionEngine) -> bool {
        engine
            .pending_refine_reply
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some()
    }

    fn flight_some(engine: &AgentSessionEngine) -> bool {
        engine
            .refine_flight
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some()
    }

    fn local_harness_state(dir: &std::path::Path) -> serde_json::Value {
        let path = dir
            .join("sessions")
            .join("harness")
            .join("harness_state.json");
        std::fs::read_to_string(&path).map_or(serde_json::Value::Null, |content| {
            serde_json::from_str(&content).expect("harness state parses")
        })
    }

    /// The wake parks the child's reply instead of applying inside the
    /// delivery: the delivery answers at once, the flight moves into the
    /// parked cell, and nothing touches the harness store yet — the apply
    /// runs at the session's idle boundary. A sender that is not the
    /// in-flight child never parks. Red when the park is lost (the park
    /// call applies, or the flight survives with a parked reply).
    #[test]
    fn a_reply_parks_without_applying_and_holds_the_lane() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, dir) = park_engine();
        park_flight(&engine, flight_for(dir.path(), RefinementSource::User));
        // Not this session's child: no park, the flight survives.
        assert!(
            engine
                .park_refine_child_reply("active-2", PROPOSAL)
                .is_none(),
            "a foreign sender never parks"
        );
        assert!(
            flight_some(&engine),
            "the flight survived the foreign reply"
        );
        // The child's reply parks.
        assert_eq!(
            engine.park_refine_child_reply("active-1", PROPOSAL),
            Some(()),
            "the child's reply parks"
        );
        assert!(!flight_some(&engine), "the flight consumed");
        assert!(pending_some(&engine), "the reply parked");
        assert_eq!(
            local_harness_state(dir.path()),
            serde_json::Value::Null,
            "the park never applied: no harness state was written"
        );
        // The parked reply owns the apply lane: an armed compact-trigger
        // round waits for it instead of failing its spawn.
        engine.mark_compact_auto_refine_pending();
        let outcome = engine.consume_compact_auto_refine();
        assert!(outcome.is_ok(), "the collision stays silent: {outcome:?}");
        assert!(
            engine.compact_auto_refine_pending(),
            "the trigger stays armed behind the parked reply"
        );
    }

    /// The idle apply runs the parked reply once: the proposal applies,
    /// the outcome reports the edit, and the parked cell clears — the
    /// apply itself (the Auto round's `finish` release included) is the
    /// unchanged wake-side body. Red when the apply is lost (the parked
    /// reply never applies) or repeats (the cell never clears).
    #[test]
    fn the_idle_apply_runs_the_parked_reply_once() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, dir) = park_engine();
        park_flight(&engine, flight_for(dir.path(), RefinementSource::User));
        assert_eq!(
            engine.park_refine_child_reply("active-1", PROPOSAL),
            Some(())
        );
        let outcome = engine
            .runtime
            .block_on(async { engine.apply_pending_refine_reply().await });
        let (result, source) = outcome
            .expect("the parked reply applied")
            .expect("the apply succeeded");
        assert_eq!(source, RefinementSource::User);
        assert_eq!(result.applied_edits.len(), 1);
        assert!(result.applied_edits[0].applied);
        let state = local_harness_state(dir.path());
        assert_eq!(
            state["entries"]["memory"]["m1"]["title"], "Tactic",
            "the applied harness state: {state}"
        );
        assert!(!pending_some(&engine), "the parked cell cleared");
        assert!(
            engine
                .runtime
                .block_on(async { engine.apply_pending_refine_reply().await })
                .is_none(),
            "the apply is one-shot"
        );
    }
}
