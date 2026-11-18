//! Background refinement completion, fenced to the session that scheduled it.

use super::{
    emit_refinement_event_for_generation, emit_refinement_row_for_generation,
    refine_complete_event, EventPump, SessionCore,
};
use serde_json::json;
use std::sync::{Arc, Mutex};

pub(super) fn completion_sink(
    core: Arc<Mutex<SessionCore>>,
    events: Arc<EventPump>,
) -> crate::agent_engine::RefinementCompletionSink {
    let runtime = tokio::runtime::Handle::current();
    Arc::new(move |pending| {
        let origin = {
            let core = core.lock().unwrap();
            core.store
                .as_ref()
                .map(|store| (store.session_id().to_string(), core.generation.clone()))
        };
        let core = Arc::clone(&core);
        let events = Arc::clone(&events);
        runtime.spawn(async move {
            let result = pending
                .await
                .unwrap_or_else(|error| Err(anyhow::anyhow!("refinement task failed: {error}")));
            let Some((session_id, generation)) = origin else {
                return;
            };
            match result {
                Ok(committed) => {
                    for row in committed.rows {
                        if let Ok(value) =
                            serde_json::to_value(pa_types::session::AgentMessage::Custom(row))
                        {
                            emit_refinement_row_for_generation(
                                &core,
                                &events,
                                &session_id,
                                Some(&generation),
                                &value,
                            );
                        }
                    }
                    emit_refinement_event_for_generation(
                        &core,
                        &events,
                        &session_id,
                        Some(&generation),
                        refine_complete_event(&committed.result),
                    );
                }
                Err(error) => {
                    emit_refinement_event_for_generation(
                        &core,
                        &events,
                        &session_id,
                        Some(&generation),
                        json!({ "type": "refine_failed", "error": format!("{error:#}") }),
                    );
                }
            }
        });
    })
}
