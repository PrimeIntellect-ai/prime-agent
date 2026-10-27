//! The refinement-child orchestration on the daemon engine: the
//! fire-and-wake flow. `/refine` spawns one `rlm.spawn kind="refine"` child
//! with the prepared request and returns immediately — the session lock
//! and the compaction flight are never held; the child's proposal lands as
//! the standard child-reply notification, the parent wakes, applies the
//! proposal through the existing apply machinery against a freshly
//! re-read harness state, records the refinement event, and tears the
//! child down.

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
        // (the in-flight child's reply owns the apply).
        let _spawn = self.refine_spawn_lock.lock().await;
        self.release_dead_refine_child_round().await;
        {
            let flight = self
                .refine_flight
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if flight.is_some() {
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

    /// The wake: consume the refinement child's reply. `None` when the
    /// sender is not this session's in-flight refine child; otherwise the
    /// proposal applied (`Ok`) or the refinement failed visibly (`Err`).
    pub(crate) async fn consume_refine_child_reply(
        &self,
        sender_active_session_id: &str,
        message: &str,
    ) -> Option<anyhow::Result<(RefinementResult, RefinementSource)>> {
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
        let source = flight.source;
        let outcome = self
            .apply_flight_reply(flight, message)
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
                bail!("the refinement failed: {error}");
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
        tokio::spawn(async move {
            for _ in 0..REFINEMENT_TEARDOWN_SLICES {
                if matches!(
                    children.delete_inactive_subagent(&rlm_child_id).await,
                    Ok("deleted" | "not_found")
                ) {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(
                    REFINEMENT_TEARDOWN_SLICE_MS,
                ))
                .await;
            }
            eprintln!("pa-daemon: the refinement child {rlm_child_id} never settled for teardown");
        });
    }
}
