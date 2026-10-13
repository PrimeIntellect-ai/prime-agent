//! The compact-trigger auto-refine machine: the session-side state and
//! the one consumption order the servicing surfaces share — gates first,
//! then the review, and only an approving review runs the refinement.

use pa_types::ai::Model;

use crate::refinement::executor::AutoRefineReview;
use crate::refinement::RefinementResult;

use super::refine::{now_millis, AutoRefineRound};
use super::AgentSession;

/// The boundary a pending trigger is serviced at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactAutoRefineSurface {
    /// A turn boundary between runs: a trigger under the review
    /// cooldown stays pending for a later boundary.
    Checkpoint,
    /// Session disposal: a trigger under cooldown drops without a
    /// review; a fresh trigger runs its review.
    Dispose,
}

#[derive(Debug, Default)]
pub(crate) struct CompactAutoRefineState {
    pending: bool,
    /// The last review attempt's timestamp (millis); every attempt
    /// stamps the cooldown window.
    last_review_at: Option<u64>,
    /// Settled non-error assistant turns since the last review (the
    /// review prompt's trigger line).
    settled_turns_since_review: u32,
    /// A second consumption re-arms the trigger instead of overlapping.
    in_flight: bool,
    /// A branch move bumps it; a round started on an older version drops
    /// its result — a review against the abandoned branch never applies.
    branch_version: u64,
    /// An approving review retained behind an active agent turn: the next
    /// serviced boundary runs its refinement without a new review call.
    pending_review: Option<AutoRefineReview>,
}

impl AgentSession {
    /// A successful compaction arms the compact-trigger review; sessions
    /// without the refine surface never arm — the trigger would never run.
    ///
    /// # Panics
    ///
    /// Panics if the compact auto-refine state mutex is poisoned.
    pub fn mark_compact_auto_refine_pending(&self) {
        if !self.auto_refine_allowed() {
            return;
        }
        self.compact_auto_refine
            .lock()
            .expect("compact auto-refine state lock")
            .pending = true;
    }

    /// Whether a trigger is armed or an approving review is retained:
    /// the scheduling surfaces' cheap pre-check.
    ///
    /// # Panics
    ///
    /// Panics if the compact auto-refine state mutex is poisoned.
    pub fn compact_auto_refine_pending(&self) -> bool {
        let state = self
            .compact_auto_refine
            .lock()
            .expect("compact auto-refine state lock");
        state.pending || state.pending_review.is_some()
    }

    /// Whether the branch version is still the one the round captured:
    /// false means a discard fired mid-round and the result is stale.
    ///
    /// # Panics
    ///
    /// Panics if the compact auto-refine state mutex is poisoned.
    pub(crate) fn compact_auto_refine_branch_version_unchanged(&self, captured: u64) -> bool {
        self.compact_auto_refine
            .lock()
            .expect("compact auto-refine state lock")
            .branch_version
            == captured
    }

    /// Drop the armed trigger and bump the branch version — an in-flight
    /// review started on the abandoned branch never applies its edits.
    ///
    /// # Panics
    ///
    /// Panics if the compact auto-refine state mutex is poisoned.
    pub fn discard_compact_auto_refine(&self) {
        let mut state = self
            .compact_auto_refine
            .lock()
            .expect("compact auto-refine state lock");
        state.pending = false;
        state.pending_review = None;
        state.branch_version += 1;
    }

    /// # Panics
    ///
    /// Panics if the compact auto-refine state mutex is poisoned.
    pub fn note_settled_turn_since_auto_refine_review(&self) {
        self.compact_auto_refine
            .lock()
            .expect("compact auto-refine state lock")
            .settled_turns_since_review += 1;
    }

    /// Consume the armed trigger at one boundary. `Ok(None)` is every silent
    /// outcome; `Ok(Some(result))` ran the refinement; `Err` is a failed
    /// review or refinement run (cooldown stamped either way).
    ///
    /// # Errors
    ///
    /// Returns the error of a failed auto-refine review or refinement run.
    ///
    /// # Panics
    ///
    /// Panics if the compact auto-refine state mutex is poisoned.
    pub async fn consume_compact_auto_refine(
        &self,
        model: &Model,
        api_key: Option<String>,
        global_harness_dir: std::path::PathBuf,
        surface: CompactAutoRefineSurface,
    ) -> anyhow::Result<Option<RefinementResult>> {
        let gates = self.auto_refine_gates();
        let (retained_review, settled_turns, branch_version) = {
            let mut state = self
                .compact_auto_refine
                .lock()
                .expect("compact auto-refine state lock");
            if !state.pending && state.pending_review.is_none() {
                return Ok(None);
            }
            // Gate order: the refine surface, then the `enabled` gate, then the
            // `compact` gate — a dropped trigger clears the flag and retained review.
            if !self.auto_refine_allowed() || !gates.enabled || !gates.compact {
                state.pending = false;
                state.pending_review = None;
                return Ok(None);
            }
            let under_cooldown = state
                .last_review_at
                .is_some_and(|last| now_millis().saturating_sub(last) < gates.cooldown_ms);
            if under_cooldown {
                // The pending flag stays while the cooldown runs; the
                // disposal drain drops the trigger.
                if surface == CompactAutoRefineSurface::Dispose {
                    state.pending = false;
                }
                return Ok(None);
            }
            // A round already in flight owns the review: this consumption
            // re-arms the trigger for the next boundary instead of stacking.
            if state.in_flight {
                return Ok(None);
            }
            // An approving review deferred behind an active turn runs
            // its refinement here without a new review model call.
            if let Some(review) = state.pending_review.clone() {
                state.in_flight = true;
                (
                    Some(review),
                    state.settled_turns_since_review,
                    state.branch_version,
                )
            } else {
                state.pending = false;
                state.in_flight = true;
                (None, state.settled_turns_since_review, state.branch_version)
            }
        };
        let outcome = if let Some(review) = retained_review.as_ref() {
            // The branch fence: a branch move since the retained round's start
            // dropped this review — the refinement never starts.
            if self.compact_auto_refine_branch_version_unchanged(branch_version) {
                self.run_approved_refine(review, model, api_key, global_harness_dir)
                    .await
                    .map(AutoRefineRound::Ran)
            } else {
                Ok(AutoRefineRound::Declined)
            }
        } else {
            // The post-review active-agent gate: running the refinement mid-stream
            // stalls the admitted turn and swaps its context, so the approval is retained.
            match self
                .review_compact_auto_refine(
                    model,
                    api_key.clone(),
                    &global_harness_dir,
                    settled_turns,
                    branch_version,
                )
                .await
            {
                Ok(None) => Ok(AutoRefineRound::Declined),
                Ok(Some(review)) => {
                    if self.agent().state().await.is_streaming {
                        Ok(AutoRefineRound::Deferred(review))
                    } else if !self.compact_auto_refine_branch_version_unchanged(branch_version) {
                        // The streaming await above is a branch-move window: a
                        // round resolved against a bumped version never applies.
                        Ok(AutoRefineRound::Declined)
                    } else {
                        self.run_approved_refine(&review, model, api_key, global_harness_dir)
                            .await
                            .map(AutoRefineRound::Ran)
                    }
                }
                Err(error) => Err(error),
            }
        };
        let outcome = {
            let mut state = self
                .compact_auto_refine
                .lock()
                .expect("compact auto-refine state lock");
            // The in-flight guard always releases, fresh or stale
            // alike.
            state.in_flight = false;
            // A version bump while the model call was in flight: its completion
            // does NOT stamp the moved-to branch's cooldown or reset its counter.
            if state.branch_version != branch_version {
                return Ok(None);
            }
            // A deferred round is not consumed: the review stays for the next
            // boundary, and neither the stamp nor the counter reset runs.
            if let Ok(AutoRefineRound::Deferred(review)) = &outcome {
                state.pending_review = Some(review.clone());
                return Ok(None);
            }
            // Every fresh attempt — decline, success, and failure
            // alike — stamps the cooldown and resets the counter.
            state.last_review_at = Some(now_millis());
            state.settled_turns_since_review = 0;
            // A retained review's terminal outcomes consume it; a
            // failed retained run keeps it for a post-cooldown retry.
            if retained_review.is_some() {
                if let Ok(AutoRefineRound::Ran(_)) = &outcome {
                    state.pending_review = None;
                }
            }
            outcome
        };
        match outcome {
            Ok(AutoRefineRound::Ran(result)) => Ok(Some(result)),
            // The declined round is silent; a deferred round is consumed above
            // (the arm exists for match exhaustiveness).
            Ok(AutoRefineRound::Declined | AutoRefineRound::Deferred(_)) => Ok(None),
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use pa_types::ai::Model;

    use super::super::refine::AutoRefineGates;
    use super::*;

    /// One faux provider registration with a unique api id per test
    /// (the registry is process-global).
    fn faux_model(responses: &[serde_json::Value]) -> Model {
        let script = serde_json::json!({
            "modelId": "compact-trigger-1",
            "responses": responses.to_vec(),
        });
        let parsed =
            pa_ai::faux::script::parse_faux_script(&script).expect("the faux script parses");
        let api = format!(
            "faux-trigger-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        );
        let registration =
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                api: Some(api),
                provider: Some("faux-trigger".to_string()),
                models: Some(vec![parsed.model]),
                ..Default::default()
            });
        registration.set_responses(parsed.responses);
        registration.get_model()
    }

    /// A persisted bare session with the refine surface forced on: the machine
    /// under test is the trigger bookkeeping, not the engine wiring.
    async fn session(persisted: bool) -> AgentSession {
        let model = faux_model(&[serde_json::json!({"text": "unused"})]);
        let agent_model: pa_agent::types::Model =
            super::super::provider_adapter::json_round_trip(&model)
                .expect("the faux model crosses the loop boundary");
        let provider = Arc::new(pa_agent::scripted::ScriptedProvider::new(
            agent_model.clone(),
        ));
        let options = pa_agent::agent::AgentOptions {
            initial_state: pa_agent::agent::AgentInitialState {
                model: Some(agent_model),
                ..Default::default()
            },
            stream_fn: Some(provider.stream_fn()),
            ..Default::default()
        };
        let agent = pa_agent::agent::Agent::new(options);
        let tmp = tempfile::tempdir().unwrap();
        let mut manager = crate::session::manager::SessionManager::in_memory(tmp.path());
        if persisted {
            manager.materialize_session_file(Some(tmp.path().join("session")));
        }
        let mut session = AgentSession::new(Arc::new(agent), manager, Vec::new())
            .await
            .unwrap();
        session.set_auto_refine(true, AutoRefineGates::default());
        session
    }

    fn state(session: &AgentSession) -> (bool, Option<u64>, u32) {
        let state = session.compact_auto_refine.lock().unwrap();
        (
            state.pending,
            state.last_review_at,
            state.settled_turns_since_review,
        )
    }

    async fn consume(
        session: &AgentSession,
        model: &Model,
        surface: CompactAutoRefineSurface,
    ) -> anyhow::Result<Option<RefinementResult>> {
        session
            .consume_compact_auto_refine(model, None, std::path::PathBuf::new(), surface)
            .await
    }

    #[tokio::test]
    async fn arming_requires_the_refine_surface() {
        let mut session = session(true).await;
        session.set_auto_refine(false, AutoRefineGates::default());
        session.mark_compact_auto_refine_pending();
        assert!(!state(&session).0);
    }

    #[tokio::test]
    async fn discard_drops_the_armed_trigger() {
        let session = session(true).await;
        session.mark_compact_auto_refine_pending();
        session.discard_compact_auto_refine();
        assert!(!state(&session).0);
    }

    #[tokio::test]
    async fn a_bare_consume_without_a_trigger_is_silent() {
        let session = session(true).await;
        let model = faux_model(&[serde_json::json!({"text": "never served"})]);
        assert!(matches!(
            consume(&session, &model, CompactAutoRefineSurface::Checkpoint).await,
            Ok(None)
        ));
    }

    #[tokio::test]
    async fn disabled_gates_drop_the_armed_trigger_without_a_review() {
        let mut session = session(true).await;
        session.set_auto_refine(
            true,
            AutoRefineGates {
                enabled: false,
                ..Default::default()
            },
        );
        session.mark_compact_auto_refine_pending();
        let model = faux_model(&[serde_json::json!({"text": "never served"})]);
        assert!(matches!(
            consume(&session, &model, CompactAutoRefineSurface::Checkpoint).await,
            Ok(None)
        ));
        assert!(!state(&session).0, "the trigger dropped");
    }

    #[tokio::test]
    async fn the_compact_gate_drops_the_armed_trigger_without_a_review() {
        let mut session = session(true).await;
        session.set_auto_refine(
            true,
            AutoRefineGates {
                compact: false,
                ..Default::default()
            },
        );
        session.mark_compact_auto_refine_pending();
        let model = faux_model(&[serde_json::json!({"text": "never served"})]);
        assert!(matches!(
            consume(&session, &model, CompactAutoRefineSurface::Checkpoint).await,
            Ok(None)
        ));
        assert!(!state(&session).0, "the trigger dropped");
    }

    #[tokio::test]
    async fn a_declining_review_stamps_the_cooldown_and_resets_the_counter() {
        let session = session(true).await;
        session.note_settled_turn_since_auto_refine_review();
        session.note_settled_turn_since_auto_refine_review();
        session.mark_compact_auto_refine_pending();
        let review = r#"{"shouldRefine": false, "rationale": "one-off tool output"}"#;
        let model = faux_model(&[serde_json::json!({"text": review})]);
        assert!(matches!(
            consume(&session, &model, CompactAutoRefineSurface::Checkpoint).await,
            Ok(None)
        ));
        let (pending, last_review_at, turns) = state(&session);
        assert!(!pending, "the trigger was consumed");
        assert!(last_review_at.is_some(), "the decline stamped the cooldown");
        assert_eq!(turns, 0, "the counter reset");
    }

    #[tokio::test]
    async fn a_failed_review_stamps_the_cooldown() {
        let session = session(true).await;
        session.mark_compact_auto_refine_pending();
        // An unparseable review reply is a failed review.
        let model = faux_model(&[serde_json::json!({"text": "not json"})]);
        assert!(
            consume(&session, &model, CompactAutoRefineSurface::Checkpoint)
                .await
                .is_err()
        );
        let (pending, last_review_at, turns) = state(&session);
        assert!(!pending, "the trigger was consumed");
        assert!(last_review_at.is_some(), "the failure stamped the cooldown");
        assert_eq!(turns, 0, "the counter reset");
    }

    #[tokio::test]
    async fn a_cooled_down_trigger_stays_armed_at_a_checkpoint_and_drops_at_disposal() {
        let session = session(true).await;
        session.mark_compact_auto_refine_pending();
        let review = r#"{"shouldRefine": false, "rationale": "no"}"#;
        let model = faux_model(&[
            serde_json::json!({"text": review}),
            serde_json::json!({"text": review}),
        ]);
        assert!(matches!(
            consume(&session, &model, CompactAutoRefineSurface::Checkpoint).await,
            Ok(None)
        ));
        session.mark_compact_auto_refine_pending();
        assert!(
            matches!(
                consume(&session, &model, CompactAutoRefineSurface::Checkpoint).await,
                Ok(None)
            ),
            "no review under the cooldown"
        );
        assert!(state(&session).0, "the checkpoint preserved the trigger");
        assert!(matches!(
            consume(&session, &model, CompactAutoRefineSurface::Dispose).await,
            Ok(None)
        ));
        assert!(!state(&session).0, "the disposal dropped the trigger");
    }

    #[tokio::test]
    async fn an_approving_review_runs_the_refinement() {
        let session = session(true).await;
        session.note_settled_turn_since_auto_refine_review();
        session.mark_compact_auto_refine_pending();
        let review = r#"{"shouldRefine": true, "rationale": "the turn shows a reusable tactic"}"#;
        let plan = r#"{"summary":"note the tactic","rationale":"repeated","expectedOutcome":"recall","edits":[{"action":"create","kind":"memory","id":"m1","title":"Tactic","content":"Use tactic A"}]}"#;
        let model = faux_model(&[
            serde_json::json!({"text": review}),
            serde_json::json!({"text": plan}),
        ]);
        let result = consume(&session, &model, CompactAutoRefineSurface::Checkpoint)
            .await
            .expect("the round ran")
            .expect("the review approved");
        assert!(result.applied_edits.iter().any(|edit| edit.applied));
        let (pending, last_review_at, turns) = state(&session);
        assert!(!pending);
        assert!(last_review_at.is_some(), "the success stamped the cooldown");
        assert_eq!(turns, 0, "the counter reset");
    }
}
