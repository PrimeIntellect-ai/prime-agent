//! The session's live-input reload (`/reload`'s daemon half): re-read the
//! request auth from the credential store and the MCP manager's settings
//! and auth state — the pieces another process (a `/login`, a `/mcp` key
//! flow) can change under a running session.
use super::AgentSessionEngine;

impl AgentSessionEngine {
    /// `/reload`'s session half: the request path reads the provider
    /// target per call, but a credential another process wrote into the
    /// store reaches the session only through a slot rebind. The live
    /// target keeps its model and service tier — a routed image episode
    /// serves on its own target, and a fresh resolution must not retarget
    /// an unflagged session to a changed settings default — so only the
    /// request key and headers re-resolve, never the model. The MCP
    /// manager re-reads its settings and the shared auth store (the same
    /// reload the connections view applies on open).
    pub(crate) fn reload_live_inputs(&self) {
        let live = self
            .provider_target
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if let Some(mut target) = live {
            let (api_key, headers) = self.resolve_request_key_and_headers(&target.model);
            // A rebind only carries what the store resolves for the live
            // model; nothing stored leaves the target serving as it was.
            if let Some(api_key) = api_key {
                target.api_key = Some(api_key);
            }
            if let Some(headers) = headers {
                target.headers = Some(headers);
            }
            *self
                .provider_target
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(target);
        }
        let mut manager = self
            .mcp
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        manager.reload_auth_storage();
        manager.refresh();
    }
}
