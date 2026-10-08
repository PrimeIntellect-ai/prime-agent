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
        let closure_provider = provider.clone();
        let forced = tokio::task::spawn_blocking(move || {
            let mut auth = pa_core::auth::AuthStorage::create(&agent_dir);
            let Some(pa_core::auth::AuthCredential::Oauth {
                access, refresh, ..
            }) = auth.get_all().credential(&closure_provider)
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
            match auth.force_refresh_oauth(&closure_provider) {
                Ok(_) => StoreOutcome::Refreshed,
                Err(reason) => StoreOutcome::Rejected(reason),
            }
        })
        .await;
        let Ok(outcome) = forced else {
            return AuthRecoveryOutcome::ReLoginRequired(re_login_sentence(
                &provider,
                "the refresh task failed",
            ));
        };
        match outcome {
            StoreOutcome::NotApplicable => return AuthRecoveryOutcome::Continue,
            StoreOutcome::Rejected(reason) => {
                return AuthRecoveryOutcome::ReLoginRequired(re_login_sentence(&provider, &reason));
            }
            StoreOutcome::Fresher | StoreOutcome::Refreshed => {}
        }
        self.rebind_request_target_after_refresh(&target);
        AuthRecoveryOutcome::Continue
    }

    /// Rebind the request target after a refresh: the stream reads the
    /// target per call, so the retry re-issues against the fresh
    /// credential. A slot that moved under the exchange — a live model
    /// switch resolved a new target — keeps its newer resolution: the
    /// recovery only re-binds the target the failed request was issued
    /// on, and never resurrects a cleared slot.
    fn rebind_request_target_after_refresh(&self, failed: &ProviderTarget) {
        let (api_key, headers) = self.resolve_request_key_and_headers(&failed.model);
        let mut slot = self
            .provider_target
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if slot
            .as_ref()
            .is_some_and(|current| current.model == failed.model && current.api_key == failed.api_key)
        {
            *slot = Some(ProviderTarget {
                service_tier: *self
                    .service_tier
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner),
                api_key,
                model: failed.model.clone(),
                headers,
            });
        }
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

#[cfg(test)]
mod tests {
    use super::super::super::AgentEngineConfig;
    use super::{AgentSessionEngine, ProviderTarget};
    use pa_core::session_engine::provider_auth::AuthRecoveryOutcome;

    /// One faux-provider OAuth grant in the store (the re-login shape:
    /// the served key is a stale access token).
    fn write_oauth(agent_dir: &std::path::Path, access: &str) {
        std::fs::create_dir_all(agent_dir).unwrap();
        std::fs::write(
            agent_dir.join("auth.json"),
            serde_json::json!({
                "faux": {
                    "type": "oauth",
                    "access": access,
                    "refresh": "r-ok",
                    "expires": i64::MAX
                }
            })
            .to_string(),
        )
        .unwrap();
    }

    fn model(provider: &str, id: &str) -> pa_types::ai::Model {
        serde_json::from_value(serde_json::json!({
            "id": id, "name": id, "api": "faux", "provider": provider,
            "baseUrl": "", "reasoning": false, "input": [],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 128_000, "maxTokens": 8192
        }))
        .unwrap()
    }

    fn target(provider: &str, id: &str, api_key: Option<&str>) -> ProviderTarget {
        ProviderTarget {
            service_tier: None,
            api_key: api_key.map(str::to_string),
            model: model(provider, id),
            headers: None,
        }
    }

    fn engine_over(dir: &std::path::Path) -> AgentSessionEngine {
        let agent_dir = dir.join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.to_path_buf(),
            agent_dir,
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: None,
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap()
    }

    /// A model switch that lands between the failed request and the
    /// recovery's write keeps its newer resolution: the rebind only
    /// re-binds the target the failed request was issued on.
    #[test]
    fn a_mid_recovery_model_switch_keeps_the_newer_target() {
        let dir = tempfile::TempDir::new().unwrap();
        write_oauth(&dir.path().join("agent"), "fresh-access");
        let engine = engine_over(dir.path());
        let failed = target("faux", "faux-1", Some("stale-access"));
        // The switch resolved a new target while the exchange ran.
        *engine.provider_target.write().unwrap() = Some(target("drift", "drift-1", None));
        engine.rebind_request_target_after_refresh(&failed);
        let slot = engine
            .provider_target
            .read()
            .unwrap()
            .clone()
            .expect("the switched target stays");
        assert_eq!(
            (slot.model.provider.as_str(), slot.model.id.as_str()),
            ("drift", "drift-1"),
            "the recovery never reverts the newer selection"
        );
        assert_eq!(slot.api_key, None, "the switch's resolution stands");
    }

    /// A slot that still holds the failed request re-binds to the fresh
    /// credential: the retry re-issues against the store's new token.
    #[test]
    fn an_unmoved_slot_rebinds_to_the_fresh_credential() {
        let dir = tempfile::TempDir::new().unwrap();
        write_oauth(&dir.path().join("agent"), "fresh-access");
        let engine = engine_over(dir.path());
        let failed = target("faux", "faux-1", Some("stale-access"));
        *engine.provider_target.write().unwrap() = Some(failed.clone());
        engine.rebind_request_target_after_refresh(&failed);
        let slot = engine
            .provider_target
            .read()
            .unwrap()
            .clone()
            .expect("the target stays");
        assert_eq!(
            (slot.model.provider.as_str(), slot.model.id.as_str()),
            ("faux", "faux-1")
        );
        assert_eq!(
            slot.api_key.as_deref(),
            Some("fresh-access"),
            "the rebind resolves the store's credential"
        );
    }

    /// The full recovery keeps the same conditional: a store that
    /// already outgrew the served key (a re-login) re-binds without an
    /// exchange, and a cleared slot is never resurrected.
    #[tokio::test]
    async fn a_fresher_store_credential_rebinds_the_request_target() {
        let dir = tempfile::TempDir::new().unwrap();
        write_oauth(&dir.path().join("agent"), "fresh-access");
        let engine = engine_over(dir.path());
        *engine.provider_target.write().unwrap() = Some(target("faux", "faux-1", Some("stale-access")));
        assert_eq!(
            engine.recover_provider_auth().await,
            AuthRecoveryOutcome::Continue
        );
        let slot = engine
            .provider_target
            .read()
            .unwrap()
            .clone()
            .expect("the target stays");
        assert_eq!(slot.api_key.as_deref(), Some("fresh-access"));
        assert_eq!(
            (slot.model.provider.as_str(), slot.model.id.as_str()),
            ("faux", "faux-1")
        );
    }

    /// A slot cleared while the exchange ran (a session retirement)
    /// stays cleared: the recovery never resurrects a dead target.
    #[test]
    fn a_cleared_slot_is_never_resurrected() {
        let dir = tempfile::TempDir::new().unwrap();
        write_oauth(&dir.path().join("agent"), "fresh-access");
        let engine = engine_over(dir.path());
        let failed = target("faux", "faux-1", Some("stale-access"));
        *engine.provider_target.write().unwrap() = None;
        engine.rebind_request_target_after_refresh(&failed);
        assert!(
            engine.provider_target.read().unwrap().is_none(),
            "the cleared slot stays cleared"
        );
    }
}
