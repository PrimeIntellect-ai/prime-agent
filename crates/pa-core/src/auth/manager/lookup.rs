//! The API-key lookup + OAuth refresh arm: the resolution walk over the candidate sources (runtime
//! override, prime inference env-before-stored, stored, environment, fallback) with the staleness
//! gate.

use super::{
    now_epoch_ms, parse_storage_data, refresh_flight, resolve_config_value,
    resolve_config_value_uncached, AuthApiKeyResult, AuthCredential, AuthStorage,
    PRIME_INFERENCE_PROVIDER_ID,
};

/// Why a forced refresh failed: a dead grant surfaces the re-login
/// guidance, an unexchanged attempt keeps the ordinary retry ladder.
///
/// [`ForcedRefreshFailure::Rejected`] means the provider refused the
/// grant (or a concurrent logout removed it) — the carried reason
/// belongs in the re-login sentence. [`ForcedRefreshFailure::NotExchanged`]
/// means no exchange ran at all (no stored grant, no forced-refresh
/// support, an unreadable store): the caller retries inside its
/// ordinary budget.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForcedRefreshFailure {
    /// The grant is dead; the carried reason surfaces in the re-login
    /// guidance.
    Rejected(String),
    /// No exchange ran; the ordinary retry ladder stands.
    NotExchanged(String),
}

impl std::fmt::Display for ForcedRefreshFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (Self::Rejected(reason) | Self::NotExchanged(reason)) = self;
        formatter.write_str(reason)
    }
}

impl AuthStorage {
    pub fn get_api_key_with_source_token(
        &mut self,
        provider_id: &str,
        include_fallback: bool,
    ) -> AuthApiKeyResult {
        // 1. Runtime override.
        if let Some(candidate) = self.runtime_candidate(provider_id) {
            if !self.is_stale(provider_id, &candidate) {
                if let Some(api_key) = self.runtime_overrides.get(provider_id).cloned() {
                    return AuthApiKeyResult {
                        api_key: Some(api_key),
                        source_token: Self::token_for(provider_id, &candidate),
                        credential_type: Some("api_key"),
                    };
                }
            }
        }

        let env_key = self.env_credentials.api_key(provider_id);
        let env_candidate = self.environment_candidate(provider_id);

        // 2. Prime-inference: environment before stored.
        if provider_id == PRIME_INFERENCE_PROVIDER_ID {
            if let (Some(api_key), Some(candidate)) = (env_key.clone(), env_candidate.clone()) {
                if !self.is_stale(provider_id, &candidate) {
                    return AuthApiKeyResult {
                        api_key: Some(api_key),
                        source_token: Self::token_for(provider_id, &candidate),
                        credential_type: Some("api_key"),
                    };
                }
            }
        }

        // 3. Stored credential.
        if let Some(credential) = self.data.credential(provider_id) {
            if let Some(candidate) = self.stored_candidate(provider_id) {
                if !self.is_stale(provider_id, &candidate) {
                    match &credential {
                        AuthCredential::ApiKey { key, .. } => {
                            let has_stale_record =
                                !self.matching_stale(provider_id, &candidate).is_empty();
                            let api_key = if key.starts_with('!') && has_stale_record {
                                resolve_config_value_uncached(key)
                            } else {
                                resolve_config_value(key)
                            };
                            return AuthApiKeyResult {
                                api_key,
                                source_token: Self::token_for(provider_id, &candidate),
                                credential_type: Some("api_key"),
                            };
                        }
                        AuthCredential::Oauth { expires, .. } => {
                            let now_ms = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map_or(i64::MAX, |d| d.as_millis() as i64);
                            if now_ms >= *expires {
                                if let Some(refreshed) = self.refresh_oauth(provider_id) {
                                    let candidate = self.stored_candidate(provider_id);
                                    return AuthApiKeyResult {
                                        api_key: self.oauth.api_key_for(provider_id, &refreshed),
                                        source_token: candidate
                                            .and_then(|c| Self::token_for(provider_id, &c)),
                                        credential_type: Some("oauth"),
                                    };
                                }
                                // Refresh failed: keep credentials for a
                                // later retry; discovery skips the provider.
                                return AuthApiKeyResult::default();
                            }
                            return AuthApiKeyResult {
                                api_key: self.oauth.api_key_for(provider_id, &credential),
                                source_token: Self::token_for(provider_id, &candidate),
                                credential_type: Some("oauth"),
                            };
                        }
                        // A pasted MCP static token IS the api key for its
                        // `mcp:<server>` provider: the bearer value, used verbatim.
                        AuthCredential::McpStaticToken { bearer, .. } => {
                            return AuthApiKeyResult {
                                api_key: Some(bearer.clone()),
                                source_token: Self::token_for(provider_id, &candidate),
                                credential_type: Some("mcp_static_token"),
                            };
                        }
                    }
                }
            }
        }

        // 4. Environment for non-prime-inference providers.
        if provider_id != PRIME_INFERENCE_PROVIDER_ID {
            if let (Some(api_key), Some(candidate)) = (env_key, env_candidate) {
                if !self.is_stale(provider_id, &candidate) {
                    return AuthApiKeyResult {
                        api_key: Some(api_key),
                        source_token: Self::token_for(provider_id, &candidate),
                        credential_type: None,
                    };
                }
            }
        }

        // 5. Fallback resolver.
        if include_fallback {
            if let Some(candidate) = self.fallback_candidate(provider_id) {
                if !self.is_stale(provider_id, &candidate) {
                    let api_key = self
                        .fallback_resolver
                        .as_ref()
                        .and_then(|resolver| resolver(provider_id));
                    return AuthApiKeyResult {
                        api_key,
                        source_token: Self::token_for(provider_id, &candidate),
                        credential_type: None,
                    };
                }
            }
        }

        AuthApiKeyResult::default()
    }

    pub fn get_api_key(&mut self, provider_id: &str) -> Option<String> {
        self.get_api_key_with_source_token(provider_id, true)
            .api_key
    }

    /// Refresh an expired OAuth credential, returning the new credential on success.
    ///
    /// Load-then-lock shape: the token fetch never runs under the document lock
    /// (TS refreshes inside `withLockAsync`; its single-threaded runtime pays nothing,
    /// but a fetch under this port's lock would stall every same-process auth read
    /// and write). The phases:
    ///
    /// 1. LOAD: the document through the read arm (no document lock).
    /// 2. FETCH: the token call outside every lock, behind [`refresh_flight`]'s
    ///    single-flight gate; the expiry is re-checked under the gate so a second
    ///    fetch never wastes a single-use refresh token.
    /// 3. WRITE: the locked read-modify-write, holding the lock only for the re-read,
    ///    insert, and atomic write. A peer that refreshed meanwhile keeps its fresher
    ///    credential.
    fn refresh_oauth(&mut self, provider_id: &str) -> Option<AuthCredential> {
        // LOAD: no document lock.
        let Ok(content) = self.storage.read() else {
            // A failed read: reload, then serve the stored credential.
            self.reload();
            return self
                .data
                .credential(provider_id)
                .filter(|c| matches!(c, AuthCredential::Oauth { .. }));
        };
        let Ok(data) = parse_storage_data(content.as_deref()) else {
            self.reload();
            return self
                .data
                .credential(provider_id)
                .filter(|c| matches!(c, AuthCredential::Oauth { .. }));
        };
        let Some(credential) = data.credential(provider_id) else {
            self.reload();
            return None;
        };
        let AuthCredential::Oauth { expires, .. } = &credential else {
            self.reload();
            return None;
        };
        if now_epoch_ms() < *expires {
            self.reload();
            return Some(credential);
        }
        // FETCH + WRITE behind the per-provider flight: a waiter that
        // acquires the flight after this fetch sees this attempt's write
        // land before spending the same single-use refresh token (the
        // forced-refresh path holds the same guarantee).
        let _flight = refresh_flight(provider_id);
        // Cross-process exclusion: the flight only serializes this
        // process; another worker process refreshing the same shared
        // credential file waits here, and the re-check below then serves
        // its result without a second exchange. A live incumbent past the
        // wait bound keeps the exchange from running at all — the stored
        // credential stands for a later retry.
        let Ok(_cross_process) = self.storage.refresh_exclusion() else {
            self.reload();
            return None;
        };
        let fetched = {
            // The gate may have just released a flight that wrote a fresh
            // credential; re-check before spending a refresh token.
            let content = self.storage.read().unwrap_or_default();
            if let Some(credential) = parse_storage_data(content.as_deref())
                .ok()
                .and_then(|data| data.credential(provider_id))
                .filter(|credential| {
                    matches!(
                        credential,
                        AuthCredential::Oauth { expires, .. } if now_epoch_ms() < *expires
                    )
                })
            {
                self.reload();
                return Some(credential);
            }
            self.oauth.refresh(provider_id, &data)
        };
        let Some(new_credential) = fetched else {
            // Refresh failed: keep credentials for a later retry; a peer
            // may have refreshed meanwhile, so reload before failing.
            self.reload();
            return None;
        };
        // WRITE: the locked read-modify-write.
        let mut refreshed: Option<AuthCredential> = Some(new_credential.clone());
        let result = self.storage.with_lock(&mut |current| {
            let mut data = parse_storage_data(current.as_deref())?;
            if let Some(credential) = data.credential(provider_id).filter(|credential| {
                matches!(
                    credential,
                    AuthCredential::Oauth { expires, .. } if now_epoch_ms() < *expires
                )
            }) {
                // A peer refreshed while this fetch ran: its fresher
                // credential stands and this attempt writes nothing.
                refreshed = Some(credential);
                return Ok(((), None));
            }
            data.insert(provider_id, &new_credential);
            let content = serde_json::to_string_pretty(&data.0)?;
            Ok(((), Some(content)))
        });
        if result.is_err() {
            // A peer may have refreshed successfully; reload before failing.
            self.reload();
            return self
                .data
                .credential(provider_id)
                .filter(|c| matches!(c, AuthCredential::Oauth { .. }));
        }
        // Reload from what we wrote: the in-memory snapshot must not serve the
        // pre-refresh credential (a rotated refresh token is single-use).
        self.reload();
        refreshed
    }

    /// Force-refresh a stored OAuth credential: the server rejected a
    /// locally-valid token (a 401 before the stored expiry), so the expiry
    /// gates step aside while the fetch single-flight and the locked
    /// read-modify-write stay. `Ok` = the store now holds a fresher
    /// credential (refreshed here or by a peer); `Err` = no usable
    /// credential resulted and the stored one stands untouched.
    ///
    /// The peer checks compare access tokens, not expiry: a future-dated
    /// `expires` is exactly what a forced refresh runs against.
    ///
    /// # Errors
    ///
    /// [`ForcedRefreshFailure::Rejected`] carries the provider's refusal
    /// (or a concurrent logout); [`ForcedRefreshFailure::NotExchanged`]
    /// marks the attempts that never exchanged (an unreadable store, no
    /// OAuth grant, no forced-refresh support, a failed write-back).
    pub fn force_refresh_oauth(
        &mut self,
        provider_id: &str,
    ) -> Result<AuthCredential, ForcedRefreshFailure> {
        let Ok(content) = self.storage.read() else {
            self.reload();
            return Err(ForcedRefreshFailure::NotExchanged(
                "the credential store could not be read".to_string(),
            ));
        };
        let Ok(data) = parse_storage_data(content.as_deref()) else {
            self.reload();
            return Err(ForcedRefreshFailure::NotExchanged(
                "the credential store could not be parsed".to_string(),
            ));
        };
        let credential = data.credential(provider_id).filter(|credential| {
            matches!(
                credential,
                AuthCredential::Oauth { refresh: Some(refresh_token), .. }
                    if !refresh_token.is_empty()
            )
        });
        // The loaded credential itself, for the write guard's
        // same-credential check (the destructure below consumes it).
        let loaded = credential.clone();
        let Some(AuthCredential::Oauth { .. }) = credential else {
            self.reload();
            return Err(ForcedRefreshFailure::NotExchanged(format!(
                "the stored credential for {provider_id} carries no refresh token"
            )));
        };
        // FETCH + WRITE behind the per-provider flight: the guard stays
        // alive through persistence and reload, so a concurrent caller
        // never re-spends the same single-use refresh token before this
        // attempt's write lands. A peer that refreshed against the same
        // rejection through the expiry-gated path still stands — the peer
        // check below serves its fresh credential without a fetch.
        let _flight = refresh_flight(provider_id);
        // Cross-process exclusion: another worker process refreshing the
        // same shared credential file waits here, and this attempt's peer
        // checks then serve its result without a second exchange. A live
        // incumbent past the wait bound keeps the exchange from running
        // at all — the ordinary ladder stands.
        let _cross_process = self
            .storage
            .refresh_exclusion()
            .map_err(ForcedRefreshFailure::NotExchanged)?;
        // An unreadable store cannot verify the peer state: the exchange
        // would spend a token this attempt may not own.
        let Ok(content) = self.storage.read() else {
            self.reload();
            return Err(ForcedRefreshFailure::NotExchanged(
                "the credential store could not be re-read".to_string(),
            ));
        };
        // A malformed document is not a removal: the ordinary retry
        // ladder stands, as the initial read's parse failure does.
        let Ok(data) = parse_storage_data(content.as_deref()) else {
            self.reload();
            return Err(ForcedRefreshFailure::NotExchanged(
                "the credential store could not be parsed".to_string(),
            ));
        };
        let peer = data.credential(provider_id);
        // Any changed credential stands — a fresher OAuth grant from the
        // expiry-gated path, an API-key replacement, a re-login to a
        // different grant: none spends this attempt's refresh token.
        // A removed grant is a concurrent logout: the exchange would
        // spend a token the store no longer wants — the re-login
        // guidance is the fix, not a refresh.
        match peer {
            Some(peer) if Some(&peer) != loaded.as_ref() => {
                self.reload();
                return Ok(peer);
            }
            Some(_) => {}
            None => {
                self.reload();
                return Err(ForcedRefreshFailure::Rejected(format!(
                    "the stored credential for {provider_id} was removed"
                )));
            }
        }
        let fetched = self.oauth.refresh_forced(provider_id, &data);
        let new_credential = match fetched {
            None => {
                self.reload();
                return Err(ForcedRefreshFailure::NotExchanged(format!(
                    "{provider_id} has no forced-refresh support"
                )));
            }
            Some(Err(reason)) => {
                // A peer's forced refresh may have won the single-use
                // token race and landed a credential this load never
                // saw: it settles the recovery without surfacing the
                // rejection this attempt got.
                self.reload();
                // A replacement credential the failed fetch never saw —
                // an API-key swap, a re-login — settles the recovery
                // without surfacing the rejection.
                if let Some(credential) = self
                    .data
                    .credential(provider_id)
                    .filter(|credential| Some(credential) != loaded.as_ref())
                {
                    return Ok(credential);
                }
                // Only a refusal (a 400/401/403 in the provider's reason)
                // proves the grant dead: a transient endpoint failure
                // (transport, 5xx) keeps the ordinary retry ladder
                // instead of a false re-login.
                return Err(
                    if crate::auth::provider_oauth::is_grant_rejection(&reason) {
                        ForcedRefreshFailure::Rejected(reason)
                    } else {
                        ForcedRefreshFailure::NotExchanged(reason)
                    },
                );
            }
            Some(Ok(new_credential)) => new_credential,
        };
        // WRITE: the locked read-modify-write. The entry only replaces
        // the credential this attempt loaded; any change that landed under
        // the fetch — a peer's fresher grant, an API-key replacement, a
        // logout — stands untouched.
        // The exchange rotated the single-use refresh token: the locked write
        // must take the new grant or the store keeps a dead one. A
        // transient write failure gets a bounded retry; a persistent
        // failure still serves the rotated grant to this caller — the
        // store's dead token rejects on the next turn and its recovery
        // surfaces the re-login guidance.
        let mut result: anyhow::Result<()> = Err(anyhow::anyhow!("unwritten"));
        let mut outcome = Err(ForcedRefreshFailure::NotExchanged(
            "the refreshed credential could not be stored".to_string(),
        ));
        for _ in 0..3 {
            outcome = Err(ForcedRefreshFailure::NotExchanged(
                "the refreshed credential could not be stored".to_string(),
            ));
            result = self.storage.with_lock(&mut |current| {
                let mut data = parse_storage_data(current.as_deref())?;
                match data.credential(provider_id) {
                    Some(changed) if Some(&changed) != loaded.as_ref() => {
                        outcome = Ok(changed);
                        return Ok(((), None));
                    }
                    None => {
                        outcome = Err(ForcedRefreshFailure::Rejected(format!(
                            "the stored credential for {provider_id} was removed while refreshing"
                        )));
                        return Ok(((), None));
                    }
                    Some(_) => {}
                }
                data.insert(provider_id, &new_credential);
                outcome = Ok(new_credential.clone());
                let content = serde_json::to_string_pretty(&data.0)?;
                Ok(((), Some(content)))
            });
            // The guard arms settle without writing (with_lock
            // succeeds); a real write error — including one after the
            // callback already staged the grant — is worth another
            // attempt.
            if result.is_ok() {
                break;
            }
        }
        if result.is_ok() {
            // Reload from what we wrote: the in-memory snapshot must not
            // serve the pre-refresh credential (a rotated refresh token
            // is single-use).
            self.reload();
            return outcome;
        }
        // Every write attempt failed: serve a peer's fresh credential if
        // one landed (the store holds it), else report the rotation
        // truthfully — the exchange spent the single-use refresh token,
        // so the stored grant is dead and the re-login guidance is the
        // fix, not a retry against the rejected access token.
        self.reload();
        match self
            .data
            .credential(provider_id)
            .filter(|credential| Some(credential) != loaded.as_ref())
        {
            Some(credential) => Ok(credential),
            None => Err(ForcedRefreshFailure::Rejected(
                "the refreshed credential could not be stored".to_string(),
            )),
        }
    }
}
