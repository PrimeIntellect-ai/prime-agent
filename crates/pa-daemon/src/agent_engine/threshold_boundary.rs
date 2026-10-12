//! Yield a tool run at its foreground compaction boundary.
use std::sync::{atomic::Ordering, Arc};

use super::AgentSessionEngine;

impl AgentSessionEngine {
    pub(super) fn threshold_boundary_hook(&self) -> pa_agent::agent_loop::ShouldStopAfterTurnFn {
        let session = Arc::downgrade(&self.session);
        let target = Arc::clone(&self.provider_target);
        let yielded = Arc::clone(&self.threshold_yielded);
        let enabled = Arc::clone(&self.threshold_checks_enabled);
        Arc::new(move |context| {
            let session = session.clone();
            let target = Arc::clone(&target);
            let yielded = Arc::clone(&yielded);
            let enabled = Arc::clone(&enabled);
            Box::pin(async move {
                if context.tool_results.is_empty() || !enabled.load(Ordering::SeqCst) {
                    return Ok(false);
                }
                let Some(session) = session.upgrade() else {
                    return Ok(false);
                };
                let engine = session.lock().await.clone();
                let Some(engine) = engine else {
                    return Ok(false);
                };
                // Capture the actual serving model before AgentEnd clears a routed override.
                let model = target
                    .read()
                    .expect("provider target lock")
                    .as_ref()
                    .map(|target| target.model.clone());
                let Some(model) = model else { return Ok(false) };
                let agent = engine.session.agent();
                let thinking = match agent.model_override() {
                    Some(route) => route.thinking_level,
                    None => agent.state().await.thinking_level,
                };
                let messages = context
                    .context
                    .messages
                    .iter()
                    .filter_map(|message| serde_json::to_value(message).ok())
                    .filter_map(|value| serde_json::from_value(value).ok())
                    .collect::<Vec<_>>();
                let due = pa_core::session_engine::compaction::threshold_compaction_due(
                    &messages,
                    model.context_window,
                    pa_core::session_engine::compaction::request_output_budget(
                        &model,
                        pa_core::session_engine::provider_adapter::model_thinking_level(thinking),
                    ),
                    &engine.session.compaction_settings(),
                );
                if due {
                    yielded.store(true, Ordering::SeqCst);
                }
                Ok(due)
            })
        })
    }
}
