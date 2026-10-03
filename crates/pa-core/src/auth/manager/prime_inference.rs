//! The Prime Inference credential writes (moved with its concern): the
//! locked read/modify/write of the prime-inference credential, the api-key
//! store with its team selection, the team rebind, and the stored team
//! read (TS setPrimeInferenceApiKey / setPrimeInferenceTeamSelection /
//! getPrimeInferenceTeamSelection), and the team header and key those
//! selections and a prime CLI directory context feed. The methods stay inherent on
//! `AuthStorage`: the impl owns the private lock and reload machinery they
//! wrap.

use super::*;

impl AuthStorage {
    /// TS `updatePrimeInferenceCredential`: one locked read/modify/write of
    /// the prime-inference credential; an update returning `None` leaves
    /// the document untouched. `true` when the locked run completed (TS
    /// returns normally; a write failure throws, so the callers must not
    /// treat a failed run as applied).
    fn update_prime_inference_credential(
        &mut self,
        update: impl FnOnce(Option<AuthCredential>) -> Option<AuthCredential>,
    ) -> bool {
        if self.load_error.is_some() {
            return false;
        }
        let mut update = Some(update);
        let result = self.storage.with_lock(&mut |current| {
            let mut data = parse_storage_data(current.as_deref())?;
            let existing = data.credential(PRIME_INFERENCE_PROVIDER_ID);
            let Some(credential) =
                (update.take().expect("the lock runs the update once"))(existing)
            else {
                return Ok(((), None));
            };
            data.insert(PRIME_INFERENCE_PROVIDER_ID, &credential);
            // TS writes `primeTeam: null` explicitly for the personal
            // account (`{ ...credential, primeTeam: null }`); the
            // declarative serde skips a `None` field, so the prime write
            // restores the key. The generic `set` keeps the TS omit
            // shape for other providers' keys.
            if let Some(serde_json::Value::Object(map)) =
                data.0.get_mut(PRIME_INFERENCE_PROVIDER_ID)
            {
                map.entry("primeTeam")
                    .or_insert_with(|| serde_json::Value::Null);
            }
            let content = serde_json::to_string_pretty(&data.0)?;
            Ok(((), Some(content)))
        });
        if let Err(error) = result {
            self.errors.push(error.to_string());
            return false;
        }
        self.reload();
        true
    }

    /// TS `setPrimeInferenceApiKey`: store the key and its team selection.
    pub fn set_prime_inference_api_key(&mut self, api_key: &str, team: PrimeTeamAssignment) {
        let api_key = api_key.to_string();
        let applied = self.update_prime_inference_credential(|existing| {
            let prime_team = match team {
                PrimeTeamAssignment::Team(team) => Some(team),
                PrimeTeamAssignment::PersonalAccount => None,
                // TS `undefined`: keep the stored team on the same key.
                PrimeTeamAssignment::PreserveWhenKeyMatches => match existing {
                    Some(AuthCredential::ApiKey {
                        key,
                        prime_team: stored,
                    }) if key == api_key => stored,
                    _ => None,
                },
            };
            Some(AuthCredential::ApiKey {
                key: api_key,
                prime_team,
            })
        });
        // TS: the stale clear sits after the write and never runs on a
        // failed one — a failed replacement must not re-enable the
        // server-rejected credential.
        if applied {
            self.clear_stale_auth_source(PRIME_INFERENCE_PROVIDER_ID, AuthSource::Stored);
        }
    }

    /// TS `setPrimeInferenceTeamSelection`: rebind the stored key's team;
    /// `expected_api_key: None` skips the key check (TS `undefined`).
    pub fn set_prime_inference_team_selection(
        &mut self,
        team: Option<PrimeTeamCredential>,
        expected_api_key: Option<&str>,
    ) {
        self.update_prime_inference_credential(|existing| {
            let Some(AuthCredential::ApiKey { key, .. }) = existing else {
                return None;
            };
            if let Some(expected) = expected_api_key {
                if key != expected {
                    return None;
                }
            }
            Some(AuthCredential::ApiKey {
                key,
                prime_team: team,
            })
        });
    }

    /// TS `getPrimeInferenceTeamSelection`: the stored team selection, or
    /// [`StoredPrimeTeam::NotSelected`] when `PRIME_TEAM_ID` pins the team
    /// or no api-key credential is stored. Fleet divergence (P5): the stored
    /// primeTeam survives runtime and environment API-key overrides — TS
    /// returns `undefined` when those are the active source, which forced
    /// dogfood daemons to pin `PRIME_TEAM_ID` in the environment; the stored
    /// login's team is used with whichever key is active instead.
    pub fn get_prime_inference_team_selection(&self) -> StoredPrimeTeam {
        if self
            .env_credentials
            .prime_team_id()
            .and_then(|value| {
                let trimmed = value.trim().to_string();
                (!trimmed.is_empty()).then_some(trimmed)
            })
            .is_some()
        {
            return StoredPrimeTeam::NotSelected;
        }
        match self.data.credential(PRIME_INFERENCE_PROVIDER_ID) {
            Some(AuthCredential::ApiKey { prime_team, .. }) => match prime_team {
                Some(team) => StoredPrimeTeam::Team(team),
                None => StoredPrimeTeam::PersonalAccount,
            },
            _ => StoredPrimeTeam::NotSelected,
        }
    }

    /// File-backed storage for a session in `cwd`: the stored credentials,
    /// with the Prime Inference team and key the directory's prime CLI
    /// context selects. Every request path builds its auth through this
    /// (or [`crate::models::ModelRegistry::for_session`]).
    #[must_use]
    pub fn for_session(
        agent_dir: impl AsRef<std::path::Path>,
        cwd: impl Into<std::path::PathBuf>,
    ) -> Self {
        Self::create(agent_dir).with_project_dir(cwd)
    }

    /// Resolve the Prime Inference team and key from the prime CLI
    /// directory context (`PRIME_CONTEXT`, else the nearest
    /// `.prime/context.json`) of the session directory `cwd`, ahead of the
    /// stored credential. The stored credential is untouched.
    #[must_use]
    pub fn with_project_dir(mut self, cwd: impl Into<std::path::PathBuf>) -> Self {
        self.project_dir = Some(cwd.into());
        self.directory_selection = DirectorySelectionMemo::default();
        self
    }

    /// What the project directory's prime CLI directory context selects:
    /// `None` without a project directory or when no context applies.
    ///
    /// # Errors
    ///
    /// A malformed pin, or a pin or `PRIME_CONTEXT` naming a missing or
    /// malformed saved context. The request auth falls back to the stored
    /// credential; the turn preflight refuses Prime Inference runs until
    /// it is fixed.
    pub fn prime_directory_selection(
        &self,
    ) -> Result<Option<crate::auth::PrimeDirectorySelection>, String> {
        self.resolved_directory_selection().clone()
    }

    /// The memoized resolution; a broken context is logged once.
    fn resolved_directory_selection(
        &self,
    ) -> &Result<Option<crate::auth::PrimeDirectorySelection>, String> {
        self.directory_selection.get_or_init(|| {
            let (Some(cwd), Some(home)) =
                (self.project_dir.as_deref(), self.env_credentials.home_dir())
            else {
                return Ok(None);
            };
            let resolved = crate::auth::prime_directory::resolve_directory_selection(
                cwd,
                &home,
                self.env_credentials.prime_context().as_deref(),
            );
            if let Err(error) = &resolved {
                tracing::warn!(%error, "invalid Prime directory context; using the stored login");
            }
            resolved
        })
    }

    /// The directory's selection, a broken one read as none.
    fn directory_selection(&self) -> Option<&crate::auth::PrimeDirectorySelection> {
        self.resolved_directory_selection().as_ref().ok()?.as_ref()
    }

    /// The API key of the saved context the directory selects: ranked after
    /// the environment and ahead of the stored login it replaces.
    pub(super) fn directory_context_candidate(
        &self,
        provider: &str,
    ) -> Option<AuthSourceCandidate> {
        if provider != PRIME_INFERENCE_PROVIDER_ID {
            return None;
        }
        let selection = self.directory_selection()?;
        let api_key = selection.api_key.clone()?;
        let context = selection.context.clone()?;
        let label = format!("Prime context '{context}'");
        Some(self.reuse_auth_source_candidate(
            AuthSource::PrimeCli,
            provider,
            format!("{context} {api_key}"),
            move || AuthSourceCandidate {
                source: AuthSource::PrimeCli,
                configured: false,
                label: Some(label),
                identity_fingerprint: fingerprint(
                    AuthSource::PrimeCli,
                    &format!("identity:prime-context {context}"),
                ),
                value_fingerprint: Some(fingerprint(
                    AuthSource::PrimeCli,
                    &format!("value:prime-context {context} {api_key}"),
                )),
                resolve_value_fingerprint: None,
            },
        ))
    }

    /// The saved context key the directory selects (see
    /// [`Self::directory_context_candidate`]).
    pub(super) fn directory_context_api_key(&self) -> Option<String> {
        self.directory_selection()?.api_key.clone()
    }

    /// Provider-scoped request headers (prime-inference team header only):
    /// `PRIME_TEAM_ID`, then the directory context, then the stored team.
    /// The stored primeTeam survives runtime and environment API-key
    /// overrides (fleet P5): an ambient `PRIME_API_KEY` supplies the key,
    /// never the team.
    pub fn get_provider_headers(
        &self,
        provider_id: &str,
    ) -> Option<std::collections::HashMap<String, String>> {
        if provider_id != PRIME_INFERENCE_PROVIDER_ID {
            return None;
        }
        let env_team = self
            .env_credentials
            .prime_team_id()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let team_id = match env_team {
            Some(team_id) => Some(team_id),
            None => match self.directory_selection() {
                Some(directory) => directory.team_id.clone(),
                None => match self.data.credential(provider_id) {
                    Some(AuthCredential::ApiKey { prime_team, .. }) => {
                        prime_team.map(|team| team.team_id)
                    }
                    _ => None,
                },
            },
        };
        team_id.map(|team_id| {
            std::collections::HashMap::from([("X-Prime-Team-ID".to_string(), team_id)])
        })
    }
}
