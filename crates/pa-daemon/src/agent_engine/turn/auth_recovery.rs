//! Provider auth recovery: the retry chains' auth seam implementation —
//! the stored OAuth credential's force-refresh, the request-target
//! rebind, and the re-login sentence when the grant is rejected.
use super::{AgentSessionEngine, ProviderTarget};
use pa_core::session_engine::provider_auth::AuthRecoveryOutcome;

/// What the credential store holds for the failing provider.
enum StoreOutcome {
    /// No OAuth grant to act on (or a create-config key owns the request).
    NotApplicable,
    /// The store already holds a credential the failing target never
    /// served (a re-login outran the stale target slot): rebinding needs
    /// no token exchange.
    Fresher,
    /// A forced exchange refreshed the stored credential.
    Refreshed,
    /// The exchange was rejected; the reason surfaces.
    Rejected(String),
}

impl AgentSessionEngine {
    /// One auth-class failure's recovery (the retry chains' seam): a
    /// stored OAuth credential for the failing provider force-refreshes
    /// and the provider target rebinds to the fresh key, so the one quick
    /// retry re-issues against the refreshed credential; a rejected grant
    /// ends the turn with the re-login sentence. A provider without a
    /// stored OAuth credential (an env or provider-config key) keeps the
    /// ordinary ladder — there is no grant to refresh.
    pub(in crate::agent_engine) async fn recover_provider_auth(&self) -> AuthRecoveryOutcome {
        // A create-config key override owns the request's credential: a
        // rejection under it is a bad override, not a dead OAuth session
        // (the preflight gate's same check).
        if self.current_selection().api_key.is_some() {
            return AuthRecoveryOutcome::Continue;
        }
        let Some(target) = self
            .provider_target
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
        else {
            return AuthRecoveryOutcome::Continue;
        };
        let provider = target.model.provider.clone();
        let agent_dir = self.config.agent_dir.clone();
        let served_key = target.api_key.clone();
        let forced = tokio::task::spawn_blocking(move || {
            let mut auth = pa_core::auth::AuthStorage::create(&agent_dir);
            let Some(pa_core::auth::AuthCredential::Oauth { access, refresh, .. }) =
                auth.get_all().credential(&provider)
            else {
                return StoreOutcome::NotApplicable;
            };
            if refresh.as_deref().is_none_or(str::is_empty) {
                return StoreOutcome::NotApplicable;
            }
            // A store that already outgrew the served key is a re-login,
            // not a dead session: rebinding to the stored credential
            // needs no exchange (the pre-/reload outage shape).
            if served_key.as_deref() != Some(access.as_str()) {
                return StoreOutcome::Fresher;
            }
            match auth.force_refresh_oauth(&provider) {
                Ok(_) => StoreOutcome::Refreshed,
                Err(reason) => StoreOutcome::Rejected(reason),
            }
        })
        .await;
        let outcome = match forced {
            Ok(outcome) => outcome,
            Err(_) => {
                return AuthRecoveryOutcome::ReLoginRequired(re_login_sentence(
                    &provider,
                    "the refresh task failed",
                ))
            }
        };
        match outcome {
            StoreOutcome::NotApplicable => return AuthRecoveryOutcome::Continue,
            StoreOutcome::Rejected(reason) => {
                return AuthRecoveryOutcome::ReLoginRequired(re_login_sentence(
                    &provider, &reason,
                ));
            }
            StoreOutcome::Fresher | StoreOutcome::Refreshed => {}
        }
        // The stream reads the provider target per call: rebind the key
        // and headers so the retry re-issues against the fresh credential.
        let (api_key, headers) = self.resolve_request_key_and_headers(&target.model);
        let mut slot = self
            .provider_target
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *slot = Some(ProviderTarget {
            service_tier: *self
                .service_tier
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            api_key,
            model: target.model.clone(),
            headers,
        });
        AuthRecoveryOutcome::Continue
    }
}

/// The re-login sentence: the preflight's message family with the
/// refresh failure's reason (the revoked-session outage surfaced the
/// provider's bare "try refreshing it" with no hint that a re-login is
/// the only fix).
fn re_login_sentence(provider: &str, reason: &str) -> String {
    format!(
        "Authentication failed for \"{provider}\" and the stored credential could not be refreshed: {reason}.\n\nRun /login to update credentials."
    )
}
