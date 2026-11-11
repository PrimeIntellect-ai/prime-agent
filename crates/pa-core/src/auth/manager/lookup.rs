//! The API-key lookup + OAuth refresh arm: the resolution walk over the candidate sources (runtime
//! override, prime inference env-before-stored, stored, environment, fallback) with the staleness
//! gate.

use super::{
    now_epoch_ms, parse_storage_data, refresh_flight, resolve_config_value,
    resolve_config_value_uncached, AuthApiKeyResult, AuthCredential, AuthSourceCandidate,
    AuthStorage, AuthStorageData, OAuthRefreshFailure, PRIME_INFERENCE_PROVIDER_ID,
};

/// Why a stored OAuth credential is rotated (the refresh-failure log field).
#[derive(Clone, Copy)]
enum RefreshTrigger {
    Expired,
    Rejected,
}

impl RefreshTrigger {
    fn as_str(self) -> &'static str {
        match self {
            RefreshTrigger::Expired => "expired",
            RefreshTrigger::Rejected => "rejected",
        }
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
                        refresh_failure: None,
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
                        refresh_failure: None,
                    };
                }
            }
        }

        // 3. Stored credential.
        if let Some(credential) = self.data.credential(provider_id) {
            if let Some(candidate) =
                self.stored_candidate(provider_id, /*resolved_command_value*/ None)
            {
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
                            // The source token reuses the value this lookup
                            // just resolved (TS's `resolvedCommandValue`):
                            // a command key resolves once per lookup, never
                            // again through the candidate's lazy fingerprint.
                            // A FAILED resolution produced no value: the
                            // deferred fingerprint is dropped too — the
                            // source token is None either way, and a failed
                            // command still retries once per lookup (TS
                            // #2497), not twice.
                            let candidate = api_key
                                .as_deref()
                                .and_then(|resolved| {
                                    self.stored_candidate(provider_id, Some(resolved))
                                })
                                .unwrap_or_else(|| AuthSourceCandidate {
                                    resolve_value_fingerprint: None,
                                    ..candidate.clone()
                                });
                            return AuthApiKeyResult {
                                api_key,
                                source_token: Self::token_for(provider_id, &candidate),
                                credential_type: Some("api_key"),
                                refresh_failure: None,
                            };
                        }
                        AuthCredential::Oauth { expires, .. } => {
                            let now_ms = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map_or(i64::MAX, |d| d.as_millis() as i64);
                            if now_ms >= *expires {
                                let refreshed = match self.refresh_oauth(provider_id) {
                                    Ok(refreshed) => refreshed,
                                    Err(failure) => {
                                        return AuthApiKeyResult {
                                            refresh_failure: Some(failure),
                                            ..AuthApiKeyResult::default()
                                        };
                                    }
                                };
                                if let Some(refreshed) = refreshed {
                                    let candidate = self.stored_candidate(
                                        provider_id,
                                        /*resolved_command_value*/ None,
                                    );
                                    return AuthApiKeyResult {
                                        api_key: self.oauth.api_key_for(provider_id, &refreshed),
                                        source_token: candidate
                                            .and_then(|c| Self::token_for(provider_id, &c)),
                                        credential_type: Some("oauth"),
                                        refresh_failure: None,
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
                                refresh_failure: None,
                            };
                        }
                        // A pasted MCP static token IS the api key for its
                        // `mcp:<server>` provider: the bearer value, used verbatim.
                        AuthCredential::McpStaticToken { bearer, .. } => {
                            return AuthApiKeyResult {
                                api_key: Some(bearer.clone()),
                                source_token: Self::token_for(provider_id, &candidate),
                                credential_type: Some("mcp_static_token"),
                                refresh_failure: None,
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
                        refresh_failure: None,
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
                        refresh_failure: None,
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

    /// The stored OAuth credential when it is fresh — a peer's completed
    /// refresh or a concurrent `/login` — else `None` (the expired
    /// credential stays stored for a later retry).
    fn stored_unexpired_credential(&self, provider_id: &str) -> Option<AuthCredential> {
        self.data.credential(provider_id).filter(|credential| {
            matches!(
                credential,
                AuthCredential::Oauth { expires, .. } if now_epoch_ms() < *expires
            )
        })
    }

    /// Refresh an expired OAuth credential, returning the new credential on success.
    ///
    /// Load-then-lock shape: the token fetch never runs under the document lock
    /// (TS refreshes inside `withLockAsync`; its single-threaded runtime pays nothing,
    /// but a fetch under this port's lock would stall every same-process auth read
    /// and write). The phases:
    ///
    /// 1. LOAD: the document through the read arm (no document lock); the expired
    ///    credential captured here is the refresh's identity guard.
    /// 2. FETCH: the token call outside the document lock, behind [`refresh_flight`]'s
    ///    process-local single-flight gate AND the backend's cross-process refresh lock
    ///    (a dedicated lock file beside the document), held through WRITE and reload;
    ///    expiry is re-checked under the lock so a concurrent process that refreshed
    ///    first is served instead of spending a second single-use refresh token. A
    ///    credential that CHANGED under the re-read (a logout removed it, a new login
    ///    replaced it) is authoritative: the refresh stops without fetching.
    /// 3. WRITE: the locked read-modify-write, holding the document lock only for the
    ///    re-read, insert, and atomic write. A peer that refreshed meanwhile keeps its
    ///    fresher credential, and the commit lands only when the current entry is
    ///    still the credential this refresh set out to rotate: a logout or a new
    ///    login that landed while the (possibly aborted, detached) fetch ran is never
    ///    overwritten or resurrected by the fetched grant.
    fn refresh_oauth(
        &mut self,
        provider_id: &str,
    ) -> Result<Option<AuthCredential>, OAuthRefreshFailure> {
        // LOAD: no document lock.
        let Ok(content) = self.storage.read() else {
            // A failed read: reload, then serve only a CURRENT credential.
            // A reload that fails too keeps the last read's data (TS
            // `reload` catches the error and leaves `this.data`), and that
            // in-memory copy may be the very credential this refresh set
            // out to rotate — expired. Serving it would stream a known
            // stale token; TS's catch path returns nothing and lets the
            // environment/fallback arms serve instead.
            self.reload();
            return Ok(self.stored_unexpired_credential(provider_id));
        };
        let Ok(data) = parse_storage_data(content.as_deref()) else {
            // A document that does not parse is the same shape: only a
            // current credential serves, never the expired in-memory copy.
            self.reload();
            return Ok(self.stored_unexpired_credential(provider_id));
        };
        let Some(credential) = data.credential(provider_id) else {
            self.reload();
            return Ok(None);
        };
        let AuthCredential::Oauth { expires, .. } = &credential else {
            self.reload();
            return Ok(None);
        };
        if now_epoch_ms() < *expires {
            self.reload();
            return Ok(Some(credential));
        }
        self.rotate_oauth(provider_id, credential, RefreshTrigger::Expired)
    }

    /// Force-refresh the stored OAuth credential the provider rejected: this
    /// store's last-read copy. A store that holds another credential keeps it.
    ///
    /// # Errors
    ///
    /// Returns the failure when the token fetch fails.
    pub fn refresh_rejected_oauth(&mut self, provider_id: &str) -> Result<(), OAuthRefreshFailure> {
        if self.runtime_overrides.contains_key(provider_id) {
            return Ok(());
        }
        match self.data.credential(provider_id) {
            Some(credential @ AuthCredential::Oauth { .. }) => self
                .rotate_oauth(provider_id, credential, RefreshTrigger::Rejected)
                .map(drop),
            Some(AuthCredential::ApiKey { .. } | AuthCredential::McpStaticToken { .. }) | None => {
                Ok(())
            }
        }
    }

    /// The FETCH and WRITE phases of [`Self::refresh_oauth`].
    fn rotate_oauth(
        &mut self,
        provider_id: &str,
        credential: AuthCredential,
        trigger: RefreshTrigger,
    ) -> Result<Option<AuthCredential>, OAuthRefreshFailure> {
        // The credential this refresh set out to rotate: its identity
        // guards the re-check and the commit, so a credential that
        // changed underneath (a logout removed it, a new login replaced
        // it) stays authoritative — the fetched grant must not
        // resurrect or overwrite it.
        let original_credential = credential;
        // FETCH: outside the document lock, one flight through commit and
        // reload. The re-check, fetch, and write hold the backend's
        // cross-process refresh lock (single-process backends report no
        // lock; the flight gate above serializes them), so concurrent
        // daemon workers resolving the same expiry never spend the same
        // single-use refresh token: a peer that refreshed first is served
        // by the re-check instead of re-fetching.
        let _flight = refresh_flight(provider_id);
        let _cross_process_refresh = match self.storage.refresh_lock(provider_id) {
            Ok(lock) => lock,
            Err(error) => {
                // The refresh lock could not be taken: a peer may be
                // mid-refresh or the lock is unhealthy. Reload and serve
                // a fresh stored credential when one exists (the TS
                // catch path) instead of racing a second token spend.
                tracing::debug!(%error, provider = provider_id, "auth refresh lock unavailable");
                self.reload();
                return Ok(self.stored_unexpired_credential(provider_id));
            }
        };
        // The gate may have just released a flight that wrote a fresh
        // credential; re-check before spending a refresh token. The
        // re-read is also the guard: a credential that changed while
        // this flight waited (a logout removed it, a new login replaced
        // it) is authoritative — the refresh stops without spending a
        // fetch on a grant the store no longer holds. A FAILED re-read
        // fails the refresh closed the same way: the LOAD-time snapshot
        // may be stale — a peer can have rotated the single-use token
        // while this caller waited for the lock — so no fetch ever runs
        // on it; only a current unexpired stored credential serves.
        let Ok(content) = self.storage.read() else {
            self.reload();
            return Ok(self.stored_unexpired_credential(provider_id));
        };
        let current = parse_storage_data(content.as_deref())
            .ok()
            .and_then(|data| data.credential(provider_id));
        let still_original = current.as_ref() == Some(&original_credential);
        if let Some(credential) = current.filter(|credential| {
            !still_original
                && matches!(
                    credential,
                    AuthCredential::Oauth { expires, .. } if now_epoch_ms() < *expires
                )
        }) {
            self.reload();
            return Ok(Some(credential));
        }
        if !still_original {
            self.reload();
            return Ok(None);
        }
        let mut data = AuthStorageData::default();
        data.insert(provider_id, &original_credential);
        let new_credential = match self.oauth.refresh(provider_id, &data) {
            Ok(new_credential) => new_credential,
            Err(mut reason) => {
                // Refresh failed: keep credentials for a later retry; a peer
                // or a concurrent `/login` may have landed a fresh credential,
                // so reload and serve it before failing (the TS catch path).
                self.reload();
                if let Some(credential) = self
                    .stored_unexpired_credential(provider_id)
                    .filter(|credential| *credential != original_credential)
                {
                    return Ok(Some(credential));
                }
                if let AuthCredential::Oauth {
                    access, refresh, ..
                } = &original_credential
                {
                    for secret in [Some(access), refresh.as_ref()].into_iter().flatten() {
                        if !secret.is_empty() {
                            reason = reason.replace(secret.as_str(), "[redacted]");
                        }
                    }
                }
                let failure = OAuthRefreshFailure {
                    provider: provider_id.to_string(),
                    reason,
                };
                pa_ai::utils::log::get_logger("auth").warn(
                    "oauth refresh failed",
                    serde_json::json!({
                        "provider": failure.provider,
                        "trigger": trigger.as_str(),
                        "reason": failure.reason,
                    }),
                );
                return Err(failure);
            }
        };
        // WRITE: the locked read-modify-write, guarded by the original
        // credential's identity: the current entry decides whether the
        // fetched grant lands at all.
        let mut refreshed: Option<AuthCredential> = None;
        let result = self.storage.with_lock(&mut |current| {
            let mut data = parse_storage_data(current.as_deref())?;
            let current_credential = data.credential(provider_id);
            let still_original = current_credential.as_ref() == Some(&original_credential);
            if let Some(credential) = current_credential.filter(|credential| {
                !still_original
                    && matches!(
                        credential,
                        AuthCredential::Oauth { expires, .. } if now_epoch_ms() < *expires
                    )
            }) {
                // A peer refreshed or a concurrent `/login` landed a
                // fresher credential while this fetch ran: it stands and
                // this attempt writes nothing, serving it instead.
                refreshed = Some(credential);
                return Ok(((), None));
            }
            if !still_original {
                // The credential changed while this fetch ran — a logout
                // removed the grant, a new login replaced it: the current
                // entry is authoritative and the fetched grant is
                // discarded, never resurrected over it.
                return Ok(((), None));
            }
            data.insert(provider_id, &new_credential);
            let content = serde_json::to_string_pretty(&data.0)?;
            refreshed = Some(new_credential.clone());
            Ok(((), Some(content)))
        });
        if result.is_err() {
            // A peer may have refreshed successfully; reload and serve a
            // fresh stored credential before failing (an expired stored
            // credential is not a refresh outcome).
            self.reload();
            return Ok(self.stored_unexpired_credential(provider_id));
        }
        // Reload from what we wrote: the in-memory snapshot must not serve the
        // pre-refresh credential (a rotated refresh token is single-use).
        self.reload();
        Ok(refreshed)
    }
}
