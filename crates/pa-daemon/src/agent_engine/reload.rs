//! The session's live-input reload (`/reload`'s daemon half): re-read the
//! MCP manager's settings and auth state — the pieces another process (a
//! `/mcp` key flow) can change under a running session. Request auth
//! needs no rebind: the live session's stream re-resolves it from the
//! credential store on every provider call (the TS streamFn), so a
//! rotated credential serves the next request with or without a reload.
use super::AgentSessionEngine;

impl AgentSessionEngine {
    /// `/reload`'s session half: re-read the MCP manager's live inputs.
    /// A failed auth-store read fails the reload (the manager keeps its
    /// previous credentials) instead of answering a success the session
    /// did not apply.
    pub(crate) fn reload_live_inputs(&self) -> Result<(), String> {
        let mut manager = self
            .mcp
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let auth_reload = manager.reload_auth_storage();
        manager.refresh();
        auth_reload
    }
}
