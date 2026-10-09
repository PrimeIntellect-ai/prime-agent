//! The session's live-input reload (`/reload`'s daemon half): re-read the
//! request auth from the credential store and the MCP manager's settings
//! and auth state — the pieces another process (a `/login`, a `/mcp` key
//! flow) can change under a running session.
use super::AgentSessionEngine;
use pa_core::session_engine::provider_adapter::ProviderTarget;

impl AgentSessionEngine {
    /// The stored request auth for the target's OWN model, applied in
    /// place: only the key and headers change, and only when the store
    /// serves a live credential for the model's provider. The configured
    /// `models.json` fallback key — what the resolution serves when the
    /// store is unreadable OR holds no credential — is not a stored
    /// credential and never replaces what the target already serves
    /// with. A resolved credential REPLACES the pair: its headers land
    /// even when it carries none, so a rotated credential without a team
    /// header clears the previous credential's `X-Prime-Team-ID` instead
    /// of serving it on the new key.
    fn refresh_request_auth(&self, target: &mut ProviderTarget) {
        let (api_key, headers, store_auth) =
            self.resolve_request_key_and_headers_and_store_health(&target.model);
        if store_auth {
            if let Some(api_key) = api_key {
                target.api_key = Some(api_key);
                target.headers = headers;
            }
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
    /// an older snapshot). A routed episode's armed target and its saved
    /// session-target fallback refresh from the same store, or the next
    /// model-turn attempt would reinstall the stale credentials. The
    /// rebinds run only off live STORE auth — a credential the store
    /// actually holds on a healthy read: the configured `models.json`
    /// fallback key (served when the store is unreadable OR holds no
    /// credential for the provider) is not a stored credential and
    /// never replaces the session's last-good pair. The MCP
    /// manager re-reads its settings and the shared auth store (the same
    /// reload the connections view applies on open). The auth store's
    /// reload gates the whole session half and its failure propagates:
    /// the request-auth resolutions read the same store a malformed
    /// document or an unacquirable lock leaves unreadable, so they would
    /// rebind the live target onto the configured fallback key over the
    /// session's last-good stored credential — the gate keeps a failed
    /// reload from touching the targets at all, and the MCP manager on
    /// its previous credentials reports the failure instead of success.
    pub(crate) fn reload_live_inputs(&self) -> Result<(), String> {
        // The whole refresh is serialized: overlapping `/reload`s each
        // resolve the store at their own read times, so without this the
        // earlier reload could install its already-resolved pair over the
        // later reload's fresher one (the model-unchanged branch trusts
        // its pre-read). Serialization makes the LAST reload to run leave
        // the target serving the newest store.
        let _serialized = self
            .reload_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // The auth store re-read runs FIRST, before any target rebind:
        // it is the health gate for the store every resolution below
        // reads. The settings re-read still applies on a failed reload —
        // it reads settings, not credentials.
        {
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
        // re-binds from the same store read.
        if let Some(route) = self
            .image_route
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_mut()
        {
            self.refresh_request_auth(&mut route.target);
            if let Some(saved) = route.session_target.as_mut() {
                self.refresh_request_auth(saved);
            }
        }
        let live_model = self
            .provider_target
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .map(|target| target.model.clone());
        if let Some(model) = live_model {
            let (api_key, headers, store_auth) =
                self.resolve_request_key_and_headers_and_store_health(&model);
            if store_auth {
                let mut slot = self
                    .provider_target
                    .write()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if let Some(target) = slot.as_mut() {
                    // The model may have moved under the store read: a
                    // switch or route swap installed a new target. The
                    // auth then re-resolves for whatever is live NOW,
                    // under the same gate; a cleared slot stays cleared.
                    let (api_key, headers) = if target.model == model {
                        (api_key, headers)
                    } else {
                        match self.resolve_request_key_and_headers_and_store_health(&target.model) {
                            (Some(key), headers, true) => (Some(key), headers),
                            // The moved-to model's provider has no live
                            // stored credential: the target keeps its
                            // last-good pair.
                            _ => (None, None),
                        }
                    };
                    // A resolved credential replaces the pair: headers
                    // clear when the fresh credential carries none.
                    if let Some(api_key) = api_key {
                        target.api_key = Some(api_key);
                        target.headers = headers;
                    }
                }
            }
        }
        Ok(())
    }
}
