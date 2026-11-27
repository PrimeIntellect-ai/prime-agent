//! Refinement completion, fenced to the session that scheduled it.

use super::{
    emit_refinement_event_for_generation, emit_refinement_row_for_generation,
    refine_complete_event, EventPump, SessionCore,
};
use pa_core::session_engine::refine::RefinementSource;
use serde_json::json;
use std::sync::{Arc, Mutex};

/// Emit one finished refinement: its durable rows and `refine_complete`, or
/// `refine_failed` naming who triggered it (print mode fails its run on a
/// `/refine` command's failure only).
pub(super) fn emit_refinement_outcome(
    core: &Arc<Mutex<SessionCore>>,
    events: &Arc<EventPump>,
    session_id: &str,
    generation: &str,
    source: RefinementSource,
    result: anyhow::Result<pa_core::session_engine::refine::CommittedRefinement>,
) {
    match result {
        Ok(committed) => {
            for row in committed.rows {
                if let Ok(value) =
                    serde_json::to_value(pa_types::session::AgentMessage::Custom(row))
                {
                    emit_refinement_row_for_generation(
                        core,
                        events,
                        session_id,
                        Some(generation),
                        &value,
                    );
                }
            }
            emit_refinement_event_for_generation(
                core,
                events,
                session_id,
                Some(generation),
                refine_complete_event(&committed.result),
            );
        }
        Err(error) => {
            emit_refinement_event_for_generation(
                core,
                events,
                session_id,
                Some(generation),
                json!({
                    "type": "refine_failed",
                    "error": format!("{error:#}"),
                    "source": source.as_str(),
                }),
            );
        }
    }
}
