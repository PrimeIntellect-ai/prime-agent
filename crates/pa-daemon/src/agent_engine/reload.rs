//! The session's live-input reload (`/reload`'s daemon half): re-read the
//! request auth from the credential store and the MCP manager's settings
//! and auth state — the pieces another process (a `/login`, a `/mcp` key
//! flow) can change under a running session.
use super::AgentSessionEngine;
use pa_core::session_engine::provider_adapter::ProviderTarget;

impl AgentSessionEngine {
    /// `/reload`'s session half: the request path reads the provider
    /// target per call, but a credential another process wrote into the
    /// store reaches the session only through a slot rebind — the same
    /// block a model switch runs. The MCP manager re-reads its settings
    /// and the shared auth store (the same reload the connections view
    /// applies on open).
    pub(in crate::agent_engine) fn reload_live_inputs(&self) {
        if let Ok(model) = self.resolve_model() {
            let (api_key, headers) = self.resolve_request_key_and_headers(&model);
            let mut target = self
                .provider_target
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            *target = Some(ProviderTarget {
                service_tier: *self
                    .service_tier
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner),
                api_key,
                model,
                headers,
            });
        }
        let mut manager = self
            .mcp
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        manager.reload_auth_storage();
        manager.refresh();
    }
}
