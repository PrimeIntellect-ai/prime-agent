//! The compact-trigger auto-refine machine on the session: the TS
//! `_compactAutoRefinePending` / `_lastAutoRefineReviewAt` /
//! `_assistantTurnsSinceAutoRefine` bookkeeping, plus the shared
//! gate/review/stamp sequence every scheduling surface applies
//! (agent-session.ts `_scheduleAutoRefineAfterCompaction`'s pending arm,
//! `_maybeAutoRefine`'s compact arm, the serialized checkpoint's
//! compact step, and dispose's serialized drain).
//!
//! The transports own *where* a trigger is serviced (the daemon worker at
//! its quiescent turn boundaries, ACP at its serialized checkpoint and
//! session close); this module owns the session-side state and the one
//! consumption order they share: gates first (the refine surface, the
//! `enabled`/`compact` settings, the review cooldown), then the review,
//! and only an approving review runs the refinement. Every review
//! attempt — decline, success, or failure — stamps the cooldown and
//! resets the turn counter (the TS contract), so a persistent failure
//! cannot retry a full review on every boundary.

use pa_types::ai::Model;

use crate::refinement::RefinementResult;

use super::refine::now_millis;
use super::AgentSession;

/// The boundary a pending trigger is serviced at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactAutoRefineSurface {
    /// A turn boundary between runs (the TS interactive path's
    /// background `_maybeAutoRefine("compact")` and the serialized
    /// checkpoint's compact step alike): a trigger under the review
    /// cooldown stays pending for a later boundary.
    Checkpoint,
    /// Session disposal (TS `dispose`: "a serialized compaction can
    /// finish without another model turn — drain its pending review here
    /// so disposal does not silently lose the trigger"): a trigger under
    /// cooldown drops without a review; a fresh trigger runs its review.
    Dispose,
}

/// The trigger state one session carries (TS `_compactAutoRefinePending`,
/// `_lastAutoRefineReviewAt`, `_assistantTurnsSinceAutoRefine`,
/// `_autoRefineBranchVersion`, `_autoRefineInProgress`).
#[derive(Debug, Default)]
pub(crate) struct CompactAutoRefineState {
    /// A successful compaction armed the trigger; the next serviced
    /// boundary runs its review.
    pending: bool,
    /// The last review attempt's timestamp (millis): every attempt —
    /// decline, success, or failure — stamps the cooldown window.
    last_review_at: Option<u64>,
    /// The settled non-error assistant turns since the last review, the
    /// count the review prompt's trigger line carries.
    settled_turns_since_review: u32,
    /// A review round is in flight (its model call awaiting): a second
    /// consumption re-arms the trigger instead of overlapping (TS
    /// `_autoRefineInProgress`).
    in_flight: bool,
    /// The branch invalidation version (TS `_autoRefineBranchVersion`):
    /// a branch move bumps it, and a round that started on an older
    /// version drops its result — a review resolved against the abandoned
    /// branch never applies its edits.
    branch_version: u64,
}

impl AgentSession {
    /// TS `_scheduleAutoRefineAfterCompaction`: a successful compaction
    /// arms the compact-trigger review. Sessions without the refine
    /// surface (TS `_autoRefineAllowedForSession`: depth 0 with a local
    /// harness state dir) never arm — the trigger would never run.
    pub fn mark_compact_auto_refine_pending(&self) {
        if !self.auto_refine_allowed() {
            return;
        }
        self.compact_auto_refine
            .lock()
            .expect("compact auto-refine state lock")
            .pending = true;
    }

    /// Whether a compaction armed the trigger (TS `_compactAutoRefinePending`):
    /// the scheduling surfaces' cheap pre-check before resolving a model.
    pub fn compact_auto_refine_pending(&self) -> bool {
        self.compact_auto_refine
            .lock()
            .expect("compact auto-refine state lock")
            .pending
    }

    /// Whether the branch invalidation version is still the one the
    /// round captured (TS `_autoRefineBranchVersion`'s post-await read):
    /// false means a discard fired mid-round and the round's result is
    /// stale — never applied, never surfaced.
    pub(crate) fn compact_auto_refine_branch_version_unchanged(&self, captured: u64) -> bool {
        self.compact_auto_refine
            .lock()
            .expect("compact auto-refine state lock")
            .branch_version
            == captured
    }

    /// TS `_discardPendingAutoRefine` +
    /// `_invalidatePendingAutoRefineForBranchChange`: drop the armed
    /// trigger outright AND bump the branch version — an in-flight
    /// review started on the abandoned branch drops its result when it
    /// resolves (the version check inside the round), so its edits never
    /// apply to the moved-to session.
    pub fn discard_compact_auto_refine(&self) {
        let mut state = self
            .compact_auto_refine
            .lock()
            .expect("compact auto-refine state lock");
        state.pending = false;
        state.branch_version += 1;
    }

    /// TS `_assistantTurnsSinceAutoRefine`'s message_end increment: one
    /// settled non-error assistant turn appended since the last review.
    pub fn note_settled_turn_since_auto_refine_review(&self) {
        self.compact_auto_refine
            .lock()
            .expect("compact auto-refine state lock")
            .settled_turns_since_review += 1;
    }

    /// Consume the armed trigger at one boundary: the shared TS gate
    /// order, then the review, and only an approving review runs the
    /// refinement. `Ok(None)` is every silent outcome — no trigger
    /// armed, a gate dropping it, the cooldown holding it, or the
    /// reviewer declining. `Ok(Some(result))` ran the refinement;
    /// `Err` is a failed review or refinement run (the cooldown is
    /// stamped either way).
    pub async fn consume_compact_auto_refine(
        &self,
        model: &Model,
        api_key: Option<String>,
        global_harness_dir: std::path::PathBuf,
        surface: CompactAutoRefineSurface,
    ) -> anyhow::Result<Option<RefinementResult>> {
        let gates = self.auto_refine_gates();
        let (settled_turns, branch_version) = {
            let mut state = self
                .compact_auto_refine
                .lock()
                .expect("compact auto-refine state lock");
            if !state.pending {
                return Ok(None);
            }
            // TS gate order (`_maybeAutoRefine` / the serialized
            // checkpoint's compact step): the refine surface, then the
            // `enabled` gate, then the `compact` gate — a dropped
            // trigger clears the pending flag.
            if !self.auto_refine_allowed() || !gates.enabled || !gates.compact {
                state.pending = false;
                return Ok(None);
            }
            let under_cooldown = state
                .last_review_at
                .is_some_and(|last| now_millis().saturating_sub(last) < gates.cooldown_ms);
            if under_cooldown {
                // TS keeps the pending flag while the cooldown runs; the
                // disposal drain drops the trigger without a review.
                if surface == CompactAutoRefineSurface::Dispose {
                    state.pending = false;
                }
                return Ok(None);
            }
            // A round already in flight owns the review (TS
            // `_autoRefineInProgress`): the background servicing makes a
            // second compaction's settle overlap the first round's model
            // call, so this consumption re-arms the trigger for the next
            // serviced boundary instead of stacking a second review.
            if state.in_flight {
                return Ok(None);
            }
            state.pending = false;
            state.in_flight = true;
            (state.settled_turns_since_review, state.branch_version)
        };
        let outcome = self
            .auto_refine_after_compaction(
                model,
                api_key,
                global_harness_dir,
                settled_turns,
                branch_version,
            )
            .await;
        let outcome = {
            let mut state = self
                .compact_auto_refine
                .lock()
                .expect("compact auto-refine state lock");
            // The round is done: the in-flight guard always releases,
            // fresh or stale alike (the next consumption may start).
            state.in_flight = false;
            // A branch move (or a session rebuild's discard) bumped the
            // version while this round's model call was in flight (TS
            // `_reviewAutoRefine`'s `branchVersion !==
            // this._autoRefineBranchVersion` check after the await): the
            // resolved review belongs to the abandoned conversation, so
            // its edits and rows never surface — and its completion does
            // NOT stamp the moved-to branch's cooldown or reset its
            // settled-turn count (a stale round must not throttle the
            // new branch's own trigger).
            if state.branch_version != branch_version {
                return Ok(None);
            }
            // TS stamps the cooldown and resets the turn counter for every
            // fresh attempt — decline, success, and failure alike — so a
            // persistent failure cannot retry a full review on every
            // boundary.
            state.last_review_at = Some(now_millis());
            state.settled_turns_since_review = 0;
            outcome
        };
        outcome
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use pa_types::ai::Model;

    use super::super::refine::AutoRefineGates;
    use super::*;

    /// One faux provider registration answering the review from its own
    /// isolated script (the registry is process-global; a unique api id
    /// per test keeps registrations independent).
    fn faux_model(responses: Vec<serde_json::Value>) -> Model {
        let script = serde_json::json!({
            "modelId": "compact-trigger-1",
            "responses": responses,
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

    /// A persisted bare session with the refine surface forced on: the
    /// machine under test is the trigger bookkeeping, not the engine
    /// wiring that resolves the surface.
    async fn session(persisted: bool) -> AgentSession {
        let model = faux_model(vec![serde_json::json!({"text": "unused"})]);
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
        let model = faux_model(vec![serde_json::json!({"text": "never served"})]);
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
        let model = faux_model(vec![serde_json::json!({"text": "never served"})]);
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
        let model = faux_model(vec![serde_json::json!({"text": "never served"})]);
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
        let model = faux_model(vec![serde_json::json!({"text": review})]);
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
        // An unparseable review reply is a failed review (TS
        // `parseAutoRefineReview` throws on non-object output).
        let model = faux_model(vec![serde_json::json!({"text": "not json"})]);
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
        let model = faux_model(vec![
            serde_json::json!({"text": review}),
            serde_json::json!({"text": review}),
        ]);
        assert!(matches!(
            consume(&session, &model, CompactAutoRefineSurface::Checkpoint).await,
            Ok(None)
        ));
        // The immediate re-arm is under the cooldown: the checkpoint
        // surface preserves the trigger without a review; the disposal
        // surface drops it.
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
        let model = faux_model(vec![
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
