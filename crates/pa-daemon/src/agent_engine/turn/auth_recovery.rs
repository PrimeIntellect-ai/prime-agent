//! Provider auth recovery: the retry chains' auth seam implementation —
//! the stored OAuth credential's force-refresh, the request-target
//! rebind, and the re-login sentence when the grant is rejected.
use super::{AgentSessionEngine, ProviderTarget};
use pa_core::session_engine::provider_auth::AuthRecoveryOutcome;
use pa_types::ai::Provider;

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

/// Whether the store's credential already outgrew the one the failed
/// request served: a served key that differs is a re-login (rebinding
/// needs no exchange); a keyless target proves nothing and must fall
/// through to the forced exchange.
fn store_outgrew_the_served_key(served: Option<&str>, access: &str) -> bool {
    served.is_some_and(|served| served != access)
}

/// Whether the slot still holds the target a recovery captured: a moved
/// slot (a live model switch resolved a new target) or a cleared one is
/// superseded — the captured target's outcome never speaks for the
/// current selection.
fn slot_still_holds(slot: Option<&ProviderTarget>, captured: &ProviderTarget) -> bool {
    slot.is_some_and(|current| {
        current.model == captured.model && current.api_key == captured.api_key
    })
}

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
        failed_provider: Provider,
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
        // A failure from a superseded selection (a model switch outran the
        // response) never touches the newer selection's grant: the retry
        // re-issues against the newer target with its own credential, and
        // the failure never consumes the episode's one auth budget — a
        // genuine rejection there still gets its own recovery round.
        if provider != failed_provider {
            return AuthRecoveryOutcome::Superseded;
        }
        let agent_dir = self.config.agent_dir.clone();
        let served_key = target.api_key.clone();
        let closure_provider = provider.clone();
        let forced = tokio::task::spawn_blocking(move || {
            let mut auth = pa_core::auth::AuthStorage::create(&agent_dir);
            let Some(credential) = auth.get_all().credential(&closure_provider) else {
                return StoreOutcome::NotApplicable;
            };
            let pa_core::auth::AuthCredential::Oauth {
                access, refresh, ..
            } = &credential
            else {
                // A non-OAuth replacement (an API-key re-login) outran
                // the stale target slot: rebinding serves it without an
                // exchange, exactly as the storage layer would.
                return StoreOutcome::Fresher;
            };
            // A store that already outgrew the served key is a re-login,
            // not a dead session: rebinding to the stored credential
            // needs no exchange (the pre-/reload outage shape) — even a
            // grant without a refresh token (a pure access-token
            // re-login) still rebinds. A keyless target is never
            // evidence of a re-login — only a served key that differs is
            // — so the keyless rejection falls through to the forced
            // exchange instead of re-binding the store's possibly stale
            // grant.
            if store_outgrew_the_served_key(served_key.as_deref(), access.as_str()) {
                return StoreOutcome::Fresher;
            }
            if refresh.as_deref().is_none_or(str::is_empty) {
                return StoreOutcome::NotApplicable;
            }
            match auth.force_refresh_oauth(&closure_provider) {
                Ok(_) => StoreOutcome::Refreshed,
                // Only the provider's rejection (or a concurrent logout)
                // ends the turn with guidance; an unexchanged attempt — no
                // forced-refresh support, an unreadable store — keeps the
                // ordinary retry ladder.
                Err(pa_core::auth::ForcedRefreshFailure::Rejected(reason)) => {
                    StoreOutcome::Rejected(reason)
                }
                Err(_) => StoreOutcome::NotApplicable,
            }
        })
        .await;
        // The exchange ran while the slot could move: a captured target
        // the slot no longer holds belongs to a superseded selection —
        // its outcome, even a rejection, is dead information, and the
        // current selection's retry proceeds with its own budget.
        if !slot_still_holds(
            self.provider_target
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .as_ref(),
            &target,
        ) {
            return AuthRecoveryOutcome::Superseded;
        }
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
        if !self.rebind_request_target_after_refresh(&target) {
            // The slot moved between the post-await check and this write:
            // the newer resolution stands and the failure never consumed
            // the auth budget.
            return AuthRecoveryOutcome::Superseded;
        }
        AuthRecoveryOutcome::NewCredential
    }

    /// Rebind the request target after a refresh: the stream reads the
    /// target per call, so the retry re-issues against the fresh
    /// credential. A slot that moved under the exchange — a live model
    /// switch resolved a new target — keeps its newer resolution: the
    /// recovery only re-binds the target the failed request was issued
    /// on, and never resurrects a cleared slot. Returns whether the
    /// captured target was re-bound; a miss leaves the newer resolution.
    fn rebind_request_target_after_refresh(&self, failed: &ProviderTarget) -> bool {
        let (api_key, headers) = self.resolve_request_key_and_headers(&failed.model);
        let mut slot = self
            .provider_target
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if slot_still_holds(slot.as_ref(), failed) {
            *slot = Some(ProviderTarget {
                service_tier: *self
                    .service_tier
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner),
                api_key,
                model: failed.model.clone(),
                headers,
            });
            return true;
        }
        false
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
    use super::{
        slot_still_holds, store_outgrew_the_served_key, AgentSessionEngine, ProviderTarget,
    };
    use pa_core::session_engine::provider_auth::AuthRecoveryOutcome;

    /// One provider's OAuth grant in the store (the re-login shape: the
    /// served key is a stale access token).
    fn write_oauth(agent_dir: &std::path::Path, provider: &str, access: &str) {
        std::fs::create_dir_all(agent_dir).unwrap();
        let mut root = serde_json::Map::new();
        root.insert(
            provider.to_string(),
            serde_json::json!({
                "type": "oauth",
                "access": access,
                "refresh": "r-ok",
                "expires": i64::MAX
            }),
        );
        std::fs::write(
            agent_dir.join("auth.json"),
            serde_json::Value::Object(root).to_string(),
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

    /// Only a served key that differs proves a re-login: a keyless
    /// target falls through to the forced exchange, and the identical
    /// served key stays on the exchange path too.
    #[test]
    fn only_a_differing_served_key_proves_a_fresher_store() {
        assert!(
            store_outgrew_the_served_key(Some("stale-access"), "fresh-access"),
            "a differing served key is a re-login"
        );
        assert!(
            !store_outgrew_the_served_key(Some("fresh-access"), "fresh-access"),
            "the served key itself is not a re-login"
        );
        assert!(
            !store_outgrew_the_served_key(None, "fresh-access"),
            "a keyless target is never evidence of a re-login"
        );
    }

    /// Only the captured target itself still speaks for the slot: a moved
    /// slot (a model switch) or a cleared one is superseded, and so is a
    /// same-model slot whose key moved (a live re-login resolved it).
    #[test]
    fn only_the_captured_target_still_holds_the_slot() {
        let captured = target("faux", "faux-1", Some("stale-access"));
        assert!(
            slot_still_holds(Some(&captured), &captured),
            "the unmoved slot still holds the captured target"
        );
        assert!(
            !slot_still_holds(Some(&target("drift", "drift-1", None)), &captured),
            "a switched slot is superseded"
        );
        assert!(
            !slot_still_holds(None, &captured),
            "a cleared slot is superseded"
        );
        assert!(
            !slot_still_holds(Some(&target("faux", "faux-1", None)), &captured),
            "a same-model slot whose key moved is superseded"
        );
    }

    /// A model switch that lands between the failed request and the
    /// recovery's write keeps its newer resolution: the rebind only
    /// re-binds the target the failed request was issued on.
    #[test]
    fn a_mid_recovery_model_switch_keeps_the_newer_target() {
        let dir = tempfile::TempDir::new().unwrap();
        write_oauth(&dir.path().join("agent"), "faux", "fresh-access");
        let engine = engine_over(dir.path());
        let failed = target("faux", "faux-1", Some("stale-access"));
        // The switch resolved a new target while the exchange ran.
        *engine.provider_target.write().unwrap() = Some(target("drift", "drift-1", None));
        assert!(
            !engine.rebind_request_target_after_refresh(&failed),
            "the missed rebind reports the move"
        );
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
        write_oauth(&dir.path().join("agent"), "faux", "fresh-access");
        let engine = engine_over(dir.path());
        let failed = target("faux", "faux-1", Some("stale-access"));
        *engine.provider_target.write().unwrap() = Some(failed.clone());
        assert!(
            engine.rebind_request_target_after_refresh(&failed),
            "the unmoved slot re-binds"
        );
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

    /// A differing grant without a refresh token still rebinds: the
    /// fresher check runs before the refresh-token requirement, so a pure
    /// access-token re-login is served instead of retrying the stale
    /// target.
    #[tokio::test]
    async fn a_refreshless_fresher_grant_still_rebinds() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::write(
            agent_dir.join("auth.json"),
            serde_json::json!({
                "faux": {
                    "type": "oauth",
                    "access": "fresh-access",
                    "expires": i64::MAX
                }
            })
            .to_string(),
        )
        .unwrap();
        let engine = engine_over(dir.path());
        *engine.provider_target.write().unwrap() =
            Some(target("faux", "faux-1", Some("stale-access")));
        assert_eq!(
            engine.recover_provider_auth("faux".to_string()).await,
            AuthRecoveryOutcome::NewCredential,
            "the refreshless fresher grant rebinds without an exchange"
        );
        let slot = engine
            .provider_target
            .read()
            .unwrap()
            .clone()
            .expect("the target stays");
        assert_eq!(
            slot.api_key.as_deref(),
            Some("fresh-access"),
            "the retry re-issues against the stored re-login"
        );
    }

    /// A non-OAuth re-login lands the same way: an API-key
    /// replacement outrunning the stale target slot serves through the
    /// rebind without any exchange.
    #[tokio::test]
    async fn a_landed_api_key_relogin_rebinds_without_an_exchange() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::write(
            agent_dir.join("auth.json"),
            serde_json::json!({
                "faux": {
                    "type": "api_key",
                    "key": "sk-relogin"
                }
            })
            .to_string(),
        )
        .unwrap();
        let engine = engine_over(dir.path());
        *engine.provider_target.write().unwrap() =
            Some(target("faux", "faux-1", Some("stale-access")));
        assert_eq!(
            engine.recover_provider_auth("faux".to_string()).await,
            AuthRecoveryOutcome::NewCredential,
            "the landed API-key re-login serves without an exchange"
        );
        let slot = engine
            .provider_target
            .read()
            .unwrap()
            .clone()
            .expect("the target stays");
        assert_eq!(
            slot.api_key.as_deref(),
            Some("sk-relogin"),
            "the rebind resolves the replacement key"
        );
    }

    /// The full recovery keeps the same conditional: a store that
    /// already outgrew the served key (a re-login) re-binds without an
    /// exchange, and a cleared slot is never resurrected.
    #[tokio::test]
    async fn a_fresher_store_credential_rebinds_the_request_target() {
        let dir = tempfile::TempDir::new().unwrap();
        write_oauth(&dir.path().join("agent"), "faux", "fresh-access");
        let engine = engine_over(dir.path());
        *engine.provider_target.write().unwrap() =
            Some(target("faux", "faux-1", Some("stale-access")));
        assert_eq!(
            engine.recover_provider_auth("faux".to_string()).await,
            AuthRecoveryOutcome::NewCredential
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

    /// A failure from a superseded selection never touches the newer
    /// grant: the failed request belongs to a provider the slot already
    /// outgrew (a model switch outran the response), so the recovery
    /// neither spends the newer provider's refresh token nor rebinds its
    /// target — the retry re-issues against the newer selection as-is.
    #[tokio::test]
    async fn a_failure_from_a_superseded_selection_never_touches_the_newer_grant() {
        let dir = tempfile::TempDir::new().unwrap();
        // The newer selection's store grant outgrew its own served key:
        // without the superseded guard the recovery would treat it as a
        // re-login and rebind.
        write_oauth(&dir.path().join("agent"), "drift", "fresh-drift");
        let engine = engine_over(dir.path());
        *engine.provider_target.write().unwrap() =
            Some(target("drift", "drift-1", Some("stale-drift")));
        assert_eq!(
            engine.recover_provider_auth("faux".to_string()).await,
            AuthRecoveryOutcome::Superseded,
            "a superseded provider's rejection never refreshes the newer grant"
        );
        let slot = engine
            .provider_target
            .read()
            .unwrap()
            .clone()
            .expect("the newer target stays");
        assert_eq!(
            slot.api_key.as_deref(),
            Some("stale-drift"),
            "the newer selection's served key is untouched"
        );
        assert_eq!(
            (slot.model.provider.as_str(), slot.model.id.as_str()),
            ("drift", "drift-1"),
            "the newer selection's resolution stands"
        );
    }

    /// A slot cleared while the exchange ran (a session retirement)
    /// stays cleared: the recovery never resurrects a dead target.
    #[test]
    fn a_cleared_slot_is_never_resurrected() {
        let dir = tempfile::TempDir::new().unwrap();
        write_oauth(&dir.path().join("agent"), "faux", "fresh-access");
        let engine = engine_over(dir.path());
        let failed = target("faux", "faux-1", Some("stale-access"));
        *engine.provider_target.write().unwrap() = None;
        assert!(
            !engine.rebind_request_target_after_refresh(&failed),
            "the cleared slot reports the miss"
        );
        assert!(
            engine.provider_target.read().unwrap().is_none(),
            "the cleared slot stays cleared"
        );
    }
}
