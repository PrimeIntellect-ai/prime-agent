//! The session's live-input reload (`/reload`'s daemon half, and the
//! saved-auth change notification): re-read the request auth from the
//! credential store and the MCP manager's settings and auth state — the
//! pieces another process (a `/login`, a `/mcp` key flow) can change under
//! a running session.
use super::AgentSessionEngine;
use pa_core::session_engine::provider_adapter::ProviderTarget;

impl AgentSessionEngine {
    /// Rebind a cached target only after its own store read succeeds.
    fn rebind_request_auth(&self, target: &mut ProviderTarget) -> Result<(), String> {
        let (api_key, headers, healthy) =
            self.resolve_request_key_and_headers_and_store_health(&target.model);
        if !healthy {
            return Err("could not read credential store".to_string());
        }
        target.api_key = api_key;
        target.headers = headers;
        Ok(())
    }

    /// Refresh only targets belonging to the provider whose credentials changed.
    pub(crate) fn apply_auth_changed(&self, provider_id: &str) -> Result<(), String> {
        self.reload_request_auth(Some(provider_id))
    }

    /// Re-read MCP settings/auth and all cached request credentials.
    pub(crate) fn reload_live_inputs(&self) -> Result<(), String> {
        self.reload_request_auth(None)
    }

    fn reload_request_auth(&self, provider_id: Option<&str>) -> Result<(), String> {
        // The whole refresh is serialized against every other
        // resolve-and-install (the session's reload lock): overlapping
        // writers resolve the store at their own read times, so the last
        // writer to run must be the one leaving the newest store.
        let _serialized = self
            .reload_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Only /reload refreshes MCP settings/auth; a provider notification
        // must not touch unrelated credentials. Each target checks its own read.
        if provider_id.is_none() {
            let mut manager = self
                .mcp
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let auth_reload = manager.reload_auth_storage();
            manager.refresh();
            auth_reload?;
        }
        // The armed route refreshes FIRST, the live slot SECOND: the
        // route lock fences the route's clone-and-install against this
        // refresh order (an attempt either installs the refreshed route
        // or lands before the slot refresh — never over it), and the
        // route's saved session target is the fallback a later
        // `clear_image_route` restores when resolution fails, so its auth
        // is refreshed too.
        if let Some(route) = self
            .image_route
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_mut()
        {
            if provider_id.is_none_or(|id| route.target.model.provider == id) {
                self.rebind_request_auth(&mut route.target)?;
            }
            if let Some(saved) = route
                .session_target
                .as_mut()
                .filter(|saved| provider_id.is_none_or(|id| saved.model.provider == id))
            {
                self.rebind_request_auth(saved)?;
            }
        }
        // The live slot resolves outside its write lock (the resolution
        // can OAuth-refresh); a target that moved under the read (a
        // switch or route swap) re-resolves for whatever is live NOW, and
        // a cleared slot stays cleared.
        let live_model = self
            .provider_target
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .map(|target| target.model.clone());
        if let Some(model) =
            live_model.filter(|model| provider_id.is_none_or(|id| model.provider == id))
        {
            let (api_key, headers, healthy) =
                self.resolve_request_key_and_headers_and_store_health(&model);
            if !healthy {
                return Err("could not read credential store".to_string());
            }
            let mut slot = self
                .provider_target
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(target) = slot.as_mut() {
                if target.model == model {
                    target.api_key = api_key;
                    target.headers = headers;
                } else if provider_id.is_none_or(|id| target.model.provider == id) {
                    self.rebind_request_auth(target)?;
                }
            }
        }
        Ok(())
    }
}
