//! The compact-trigger auto-refine machine: the session-side state and the
//! one gate order the servicing surfaces share — gates first, then the
//! round. The round is now the refinement child's spawn (the review gate
//! is gone: the child's own empty-edits judgment is the gate), so the
//! consumption returns the armed options and the daemon-backed caller
//! spawns the child; the child-reply wake finishes the round.

use super::refine::{
    auto_refine_instructions, now_millis, RefineOptions, AUTO_REFINE_COMPACT_REASON,
};
use super::AgentSession;

/// The boundary a pending trigger is serviced at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactAutoRefineSurface {
    /// A turn boundary between runs: a trigger under the review
    /// cooldown stays pending for a later boundary.
    Checkpoint,
    /// Session disposal: the trigger drops without a round — a child
    /// spawned against a disposing session could never land its reply.
    Dispose,
}

#[derive(Debug, Default)]
pub(crate) struct CompactAutoRefineState {
    pending: bool,
    /// The last round attempt's timestamp (millis); every attempt
    /// stamps the cooldown window.
    last_review_at: Option<u64>,
    /// Settled non-error assistant turns since the last round.
    /// A refinement child the round spawned and whose reply has not
    /// applied yet: a second consumption re-arms the trigger instead of
    /// stacking a second child.
    in_flight: bool,
}

impl AgentSession {
    /// A successful compaction arms the compact-trigger round; sessions
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

    /// Whether a trigger is armed: the scheduling surfaces' cheap pre-check.
    ///
    /// # Panics
    ///
    /// Panics if the compact auto-refine state mutex is poisoned.
    pub fn compact_auto_refine_pending(&self) -> bool {
        self.compact_auto_refine
            .lock()
            .expect("compact auto-refine state lock")
            .pending
    }

    /// Drop the armed trigger — a branch move or a disposal abandons the
    /// conversation the trigger was armed against.
    ///
    /// # Panics
    ///
    /// Panics if the compact auto-refine state mutex is poisoned.
    pub fn discard_compact_auto_refine(&self) {
        self.compact_auto_refine
            .lock()
            .expect("compact auto-refine state lock")
            .pending = false;
    }

    /// Take one armed round: the gates first (the refine surface, the
    /// `enabled` and `compact` settings, the cooldown, the in-flight
    /// guard), then the stamp and the round's options. The daemon-backed
    /// caller spawns the refinement child with the returned options;
    /// `None` is every silent outcome (no trigger, a gate drop, the
    /// cooldown, an in-flight round, or a disposal's trigger drop).
    /// Every taken attempt stamps the cooldown and resets the counter —
    /// the caller owes the round's `finish` either way.
    ///
    /// # Panics
    ///
    /// Panics if the compact auto-refine state mutex is poisoned.
    pub fn take_compact_auto_refine_round(
        &self,
        surface: CompactAutoRefineSurface,
    ) -> Option<RefineOptions> {
        let gates = self.auto_refine_gates();
        let mut state = self
            .compact_auto_refine
            .lock()
            .expect("compact auto-refine state lock");
        if !state.pending {
            return None;
        }
        // Disposal never runs a round: the session is going away, so a
        // spawned refinement child could never land its reply. The trigger
        // drops.
        if surface == CompactAutoRefineSurface::Dispose {
            state.pending = false;
            return None;
        }
        // Gate order: the refine surface, then the `enabled` gate, then the
        // `compact` gate — a dropped trigger clears the flag.
        if !self.auto_refine_allowed() || !gates.enabled || !gates.compact {
            state.pending = false;
            return None;
        }
        let under_cooldown = state
            .last_review_at
            .is_some_and(|last| now_millis().saturating_sub(last) < gates.cooldown_ms);
        if under_cooldown {
            // The pending flag stays while the cooldown runs; a later
            // boundary takes the round.
            return None;
        }
        // A round already in flight owns the trigger: this consumption
        // re-arms the trigger for the next boundary instead of stacking.
        if state.in_flight {
            return None;
        }
        state.pending = false;
        state.in_flight = true;
        // Every fresh attempt stamps the cooldown and resets the counter.
        state.last_review_at = Some(now_millis());
        Some(RefineOptions {
            global: false,
            instructions: Some(auto_refine_instructions(AUTO_REFINE_COMPACT_REASON)),
            rollback_id: None,
        })
    }

    /// Release the in-flight round: the child-reply wake applied (or
    /// refused) the proposal, or the spawn failed — the next armed
    /// trigger may run.
    ///
    /// # Panics
    ///
    /// Panics if the compact auto-refine state mutex is poisoned.
    pub fn finish_compact_auto_refine_round(&self) {
        self.compact_auto_refine
            .lock()
            .expect("compact auto-refine state lock")
            .in_flight = false;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::super::refine::AutoRefineGates;
    use super::*;

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

    /// One faux provider registration with a unique api id per test
    /// (the registry is process-global).
    fn faux_model(responses: &[serde_json::Value]) -> pa_types::ai::Model {
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

    #[tokio::test]
    async fn arming_requires_the_refine_surface() {
        let mut session = session(true).await;
        session.set_auto_refine(false, AutoRefineGates::default());
        session.mark_compact_auto_refine_pending();
        assert!(!session.compact_auto_refine_pending());
    }

    #[tokio::test]
    async fn discard_drops_the_armed_trigger() {
        let session = session(true).await;
        session.mark_compact_auto_refine_pending();
        session.discard_compact_auto_refine();
        assert!(!session.compact_auto_refine_pending());
        assert!(session
            .take_compact_auto_refine_round(CompactAutoRefineSurface::Checkpoint)
            .is_none());
    }

    #[tokio::test]
    async fn a_bare_take_without_a_trigger_is_silent() {
        let session = session(true).await;
        assert!(session
            .take_compact_auto_refine_round(CompactAutoRefineSurface::Checkpoint)
            .is_none());
    }

    #[tokio::test]
    async fn disabled_gates_drop_the_armed_trigger_without_a_round() {
        let mut session = session(true).await;
        session.set_auto_refine(
            true,
            AutoRefineGates {
                enabled: false,
                ..Default::default()
            },
        );
        session.mark_compact_auto_refine_pending();
        assert!(session
            .take_compact_auto_refine_round(CompactAutoRefineSurface::Checkpoint)
            .is_none());
        assert!(
            !session.compact_auto_refine_pending(),
            "the trigger dropped"
        );
    }

    #[tokio::test]
    async fn the_compact_gate_drops_the_armed_trigger_without_a_round() {
        let mut session = session(true).await;
        session.set_auto_refine(
            true,
            AutoRefineGates {
                compact: false,
                ..Default::default()
            },
        );
        session.mark_compact_auto_refine_pending();
        assert!(session
            .take_compact_auto_refine_round(CompactAutoRefineSurface::Checkpoint)
            .is_none());
        assert!(
            !session.compact_auto_refine_pending(),
            "the trigger dropped"
        );
    }

    #[tokio::test]
    async fn a_taken_round_carries_the_auto_instructions_and_consumes_the_trigger() {
        let session = session(true).await;
        session.mark_compact_auto_refine_pending();
        let options = session
            .take_compact_auto_refine_round(CompactAutoRefineSurface::Checkpoint)
            .expect("the round is due");
        assert!(!options.global);
        assert!(options
            .instructions
            .as_deref()
            .is_some_and(|instructions| instructions
                .starts_with("Automatic refine review triggered by compact.")));
        assert!(
            !session.compact_auto_refine_pending(),
            "the take consumed the trigger"
        );
    }

    #[tokio::test]
    async fn an_in_flight_round_rearms_the_next_trigger_instead_of_stacking() {
        let session = session(true).await;
        session.mark_compact_auto_refine_pending();
        assert!(session
            .take_compact_auto_refine_round(CompactAutoRefineSurface::Checkpoint)
            .is_some());
        // The child is in flight: the second consumption is silent.
        session.mark_compact_auto_refine_pending();
        assert!(session
            .take_compact_auto_refine_round(CompactAutoRefineSurface::Checkpoint)
            .is_none());
        assert!(session.compact_auto_refine_pending());
        // The wake finishes the round; the cooldown keeps the next take
        // silent until it passes.
        session.finish_compact_auto_refine_round();
        assert!(session
            .take_compact_auto_refine_round(CompactAutoRefineSurface::Checkpoint)
            .is_none());
    }

    #[tokio::test]
    async fn disposal_drops_the_trigger_without_a_round() {
        let session = session(true).await;
        session.mark_compact_auto_refine_pending();
        assert!(session
            .take_compact_auto_refine_round(CompactAutoRefineSurface::Dispose)
            .is_none());
        assert!(
            !session.compact_auto_refine_pending(),
            "the disposal dropped the trigger"
        );
    }
}
