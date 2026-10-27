//! The print runtime's refinement surface: the compact-trigger auto-refine
//! and the requested refinement are the refinement child's — a daemon
//! `rlm.spawn kind="refine"` child — so the headless boundary never runs a
//! planning pass. Its one refine duty is the refusal: a model-requested
//! refinement taken at the boundary answers the daemon-required failure
//! visibly (json mode's `refine_failed`), never a silent drop.

use super::{json, SessionEngine, TurnBoundary};

impl TurnBoundary {
    /// Refuse one model-requested refinement taken at the settled boundary:
    /// the planning refinement is the refinement child's, and a headless
    /// print session has no child runtime, so the request surfaces the
    /// daemon-required failure instead of silently dropping.
    pub(crate) async fn refuse_pending_refinement(&self, engine: &SessionEngine) {
        if engine.turn_boundary.take_refine().await.is_none() {
            return;
        }
        if self.json_mode {
            self.emit_json(&json!({
                "type": "refine_failed",
                "error": "The refine command requires a daemon-backed session: the refinement child is a spawned session, and this session has no RLM child runtime.",
            }));
        } else {
            eprintln!(
                "pa-cli: the requested refinement requires a daemon-backed session; it was dropped"
            );
        }
    }

    /// The durable refinement rows appended after an entry count: the outcome row,
    /// then the model-facing notice when edits applied, in that order.
    pub(crate) async fn refinement_rows_since(
        engine: &SessionEngine,
        entries_before: usize,
    ) -> Vec<pa_types::session::CustomMessage> {
        engine
            .session
            .entries()
            .await
            .into_iter()
            .skip(entries_before)
            .filter_map(|entry| match entry {
                pa_types::session::FileEntry::CustomMessage { payload, base }
                    if payload.custom_type
                        == pa_core::session_engine::refine::REFINEMENT_OUTCOME_CUSTOM_TYPE
                        || payload.custom_type
                            == pa_core::session_engine::refine::REFINEMENT_NOTICE_CUSTOM_TYPE =>
                {
                    Some(pa_types::session::CustomMessage {
                        custom_type: payload.custom_type.clone(),
                        content: payload.content.clone(),
                        display: payload.display,
                        details: payload.details.clone(),
                        timestamp: base
                            .timestamp
                            .as_deref()
                            .map(pa_core::session::timestamp_to_millis)
                            .unwrap_or_default(),
                        rest: payload.rest,
                    })
                }
                _ => None,
            })
            .collect()
    }
}
