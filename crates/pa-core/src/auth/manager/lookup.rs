//! The API-key lookup + OAuth refresh arm: the resolution walk over the candidate sources (runtime
//! override, prime inference env-before-stored, stored, environment, fallback) with the staleness
//! gate.

use super::{
    now_epoch_ms, parse_storage_data, refresh_flight, resolve_config_value,
    resolve_config_value_uncached, AuthApiKeyResult, AuthCredential, AuthStorage,
    PRIME_INFERENCE_PROVIDER_ID,
};

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
    /// 2. FETCH: the token call outside the document lock, behind [`refresh_flight`]'s
    ///    single-flight gate, held through WRITE and reload; expiry is re-checked so a second
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
        // FETCH: outside the document lock, one flight through commit and reload.
        let _flight = refresh_flight(provider_id);
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
        let fetched = self.oauth.refresh(provider_id, &data);
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
}
