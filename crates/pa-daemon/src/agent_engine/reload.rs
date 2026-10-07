//! The session's live-input reload (`/reload`'s daemon half): re-read the
//! request auth from the credential store and the MCP manager's settings
//! and auth state — the pieces another process (a `/login`, a `/mcp` key
//! flow) can change under a running session.
use super::AgentSessionEngine;
use pa_core::session_engine::provider_adapter::ProviderTarget;

impl AgentSessionEngine {
    /// The stored request auth for the target's OWN model, applied in
    /// place: only the key and headers change, and only when the store
    /// resolves something (nothing stored never clears what the target
    /// already serves with).
    fn refresh_request_auth(&self, target: &mut ProviderTarget) {
        let (api_key, headers) = self.resolve_request_key_and_headers(&target.model);
        if let Some(api_key) = api_key {
            target.api_key = Some(api_key);
        }
        if let Some(headers) = headers {
            target.headers = Some(headers);
        }
    }

    /// `/reload`'s session half: the request path reads the provider
    /// target per call, but a credential another process wrote into the
    /// store reaches the session only through a slot rebind. The live
    /// target keeps its model and service tier — a routed image episode
    /// serves on its own target, and a fresh resolution must not retarget
    /// an unflagged session to a changed settings default — so only the
    /// request key and headers re-resolve, never the model, and the
    /// refresh lands in place on the CURRENT slot contents (a racing
    /// `set_model`, image-route swap, or retirement is never clobbered by
    /// an older snapshot). A routed episode's armed target refreshes from
    /// the same store, or the next model-turn attempt would reinstall the
    /// stale credentials. The MCP manager re-reads its settings and the
    /// shared auth store (the same reload the connections view applies
    /// on open).
    pub(crate) fn reload_live_inputs(&self) {
        let live_model = self
            .provider_target
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .map(|target| target.model.clone());
        if let Some(model) = live_model {
            let (api_key, headers) = self.resolve_request_key_and_headers(&model);
            {
                let mut slot = self
                    .provider_target
                    .write()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if let Some(target) = slot.as_mut() {
                    // The model may have moved under the store read: a
                    // switch or route swap installed a new target. The
                    // auth then re-resolves for whatever is live NOW;
                    // a cleared slot stays cleared.
                    let (api_key, headers) = if target.model == model {
                        (api_key, headers)
                    } else {
                        self.resolve_request_key_and_headers(&target.model)
                    };
                    if let Some(api_key) = api_key {
                        target.api_key = Some(api_key);
                    }
                    if let Some(headers) = headers {
                        target.headers = Some(headers);
                    }
                }
            }
        }
        if let Some(route) = self
            .image_route
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_mut()
        {
            self.refresh_request_auth(&mut route.target);
        }
        let mut manager = self
            .mcp
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        manager.reload_auth_storage();
        manager.refresh();
    }
}
