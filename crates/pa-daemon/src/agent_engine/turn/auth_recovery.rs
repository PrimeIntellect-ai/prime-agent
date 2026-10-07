//! Provider auth recovery: the retry chains' auth seam implementation —
//! the stored OAuth credential's force-refresh, the request-target
//! rebind, and the re-login sentence when the grant is rejected.
use super::{AgentSessionEngine, ProviderTarget};
use pa_core::session_engine::provider_auth::AuthRecoveryOutcome;

impl AgentSessionEngine {
    /// One auth-class failure's recovery (the retry chains' seam): a
    /// stored OAuth credential for the failing provider force-refreshes
    /// and the provider target rebinds to the fresh key, so the one quick
    /// retry re-issues against the refreshed credential; a rejected grant
    /// ends the turn with the re-login sentence. A provider without a
    /// stored OAuth credential (an env or provider-config key) keeps the
    /// ordinary ladder — there is no grant to refresh.
    pub(in crate::agent_engine) async fn recover_provider_auth(
        &self,
    ) -> AuthRecoveryOutcome {
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
        let forced = tokio::task::spawn_blocking(move || {
            let mut auth = pa_core::auth::AuthStorage::create(&agent_dir);
            // Only a stored OAuth credential has a grant to refresh.
            let stored_oauth = matches!(
                auth.get_all().credential(&provider),
                Some(pa_core::auth::AuthCredential::Oauth { .. })
            );
            if !stored_oauth {
                return Ok(None);
            }
            auth.force_refresh_oauth(&provider).map(Some)
        })
        .await;
        match forced {
            Ok(Ok(Some(_credential))) => {}
            Ok(Ok(None)) => return AuthRecoveryOutcome::Continue,
            Ok(Err(reason)) => {
                return AuthRecoveryOutcome::ReLoginRequired(re_login_sentence(
                    &provider, &reason,
                ));
            }
            Err(_) => {
                return AuthRecoveryOutcome::ReLoginRequired(re_login_sentence(
                    &provider,
                    "the refresh task failed",
                ));
            }
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
