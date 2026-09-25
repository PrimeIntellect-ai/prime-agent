//! `AuthStorage`: credential resolution with runtime overrides, environment
//! keys, stored credentials, fallback resolvers, and stale-marking. Port of
//! the `AuthStorage` class.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::Arc;

use super::resolve_config_value::{resolve_config_value, resolve_config_value_uncached};
use super::storage::{parse_storage_data, AuthStorageBackend};
use super::types::{
    AuthCredential, AuthSource, AuthSourceToken, AuthStatus, AuthStorageData, PrimeTeamAssignment,
    PrimeTeamCredential, StoredPrimeTeam, PRIME_INFERENCE_PROVIDER_ID,
};

/// SHA-256 fingerprint of an auth-source material, `source:hex` form.
fn fingerprint(source: AuthSource, material: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(format!("{source:?}"));
    hasher.update([0]);
    hasher.update(material.as_bytes());
    format!("{source:?}:{}", hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut output, b| {
        let _ = write!(output, "{b:02x}");
        output
    })
}

/// One candidate credential source.
#[derive(Clone)]
struct AuthSourceCandidate {
    source: AuthSource,
    configured: bool,
    label: Option<String>,
    identity_fingerprint: String,
    value_fingerprint: Option<String>,
    /// Deferred value material (commands that must run at read time).
    resolve_value_fingerprint: Option<ValueFingerprintResolver>,
}

impl AuthSourceCandidate {
    fn resolved_value_fingerprint(&self) -> Option<String> {
        self.value_fingerprint
            .clone()
            .or_else(|| self.resolve_value_fingerprint.as_ref().and_then(|f| f()))
    }
}

/// The result of an API-key lookup.
#[derive(Debug, Default, Clone)]
pub struct AuthApiKeyResult {
    pub api_key: Option<String>,
    pub source_token: Option<AuthSourceToken>,
    pub credential_type: Option<&'static str>,
}

/// OAuth integration seam: the pa-ai oauth provider registry implements this
/// (login flow + token refresh). Kept as a trait so auth storage stays
/// testable without network flows.
pub trait OAuthIntegration: Send + Sync {
    /// The resolved API key for stored OAuth credentials (bearer/token form).
    fn api_key_for(&self, provider_id: &str, credential: &AuthCredential) -> Option<String>;
    /// Refresh an expired credential; `None` = refresh failed.
    fn refresh(&self, provider_id: &str, credentials: &AuthStorageData) -> Option<AuthCredential>;
}

/// No OAuth provider registry available (embedded hosts); stored OAuth
/// credentials still serve their access token until expiry.
#[derive(Default)]
pub struct NoOAuth;

impl OAuthIntegration for NoOAuth {
    fn api_key_for(&self, _provider: &str, credential: &AuthCredential) -> Option<String> {
        match credential {
            AuthCredential::Oauth { access, .. } => Some(access.clone()),
            _ => None,
        }
    }

    fn refresh(&self, _provider: &str, _credentials: &AuthStorageData) -> Option<AuthCredential> {
        None
    }
}

/// Environment credential source: the seam through which auth resolution
/// reads ambient credentials (provider API-key variables, the prime team
/// variable, and multi-variable ambient identity material such as AWS
/// profiles). The production implementation reads the real process
/// environment via the shared env-var table in `pa-ai`; tests inject a fixed
/// mapping so resolution order is deterministic and hermetic against
/// ambient variables and parallel-test env mutation.
pub(crate) trait EnvCredentialSource: Send + Sync {
    /// Env var names (priority order) currently set to non-empty values that
    /// would supply the provider's API key, if any.
    fn key_names(&self, provider: &str) -> Option<Vec<String>>;
    /// The provider's API key from the environment, if any.
    fn api_key(&self, provider: &str) -> Option<String>;
    /// Raw `PRIME_TEAM_ID` value if set; the caller trims and rejects empty.
    fn prime_team_id(&self) -> Option<String>;
    /// Identity material for ambient multi-variable credential sources
    /// (AWS profiles, container credentials, Google ADC projects).
    fn ambient_identity_material(&self, provider: &str) -> String;
}

/// Process-environment credential source (production).
struct ProcessEnvCredentials;

/// No-op environment credential source: no ambient variable can supply a
/// provider key or team id. The hermetic seam behind
/// [`AuthStorage::in_memory_without_env`].
struct NoEnvCredentials;

impl EnvCredentialSource for NoEnvCredentials {
    fn key_names(&self, _provider: &str) -> Option<Vec<String>> {
        None
    }

    fn api_key(&self, _provider: &str) -> Option<String> {
        None
    }

    fn prime_team_id(&self) -> Option<String> {
        None
    }

    fn ambient_identity_material(&self, provider: &str) -> String {
        provider.to_string()
    }
}

impl EnvCredentialSource for ProcessEnvCredentials {
    fn key_names(&self, provider: &str) -> Option<Vec<String>> {
        pa_ai::env_api_keys::find_env_keys(provider)
    }

    fn api_key(&self, provider: &str) -> Option<String> {
        pa_ai::env_api_keys::get_env_api_key(provider)
    }

    fn prime_team_id(&self) -> Option<String> {
        std::env::var("PRIME_TEAM_ID").ok()
    }

    fn ambient_identity_material(&self, provider: &str) -> String {
        let env = |name: &str| std::env::var(name).unwrap_or_default();
        match provider {
            "amazon-bedrock" => {
                if !env("AWS_PROFILE").is_empty() {
                    return format!("amazon-bedrock:profile:{}", env("AWS_PROFILE"));
                }
                if !env("AWS_ACCESS_KEY_ID").is_empty() {
                    return format!(
                        "amazon-bedrock:access-key:{}:{}:{}",
                        env("AWS_ACCESS_KEY_ID"),
                        env("AWS_SECRET_ACCESS_KEY"),
                        env("AWS_SESSION_TOKEN")
                    );
                }
                if !env("AWS_BEARER_TOKEN_BEDROCK").is_empty() {
                    return format!("amazon-bedrock:bearer:{}", env("AWS_BEARER_TOKEN_BEDROCK"));
                }
                for (name, prefix) in [
                    ("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "ecs-relative"),
                    ("AWS_CONTAINER_CREDENTIALS_FULL_URI", "ecs-full"),
                    ("AWS_WEB_IDENTITY_TOKEN_FILE", "web-identity"),
                ] {
                    if !env(name).is_empty() {
                        return format!("amazon-bedrock:{prefix}:{}", env(name));
                    }
                }
                provider.to_string()
            }
            "google-vertex" => format!(
                "google-vertex:{}:{}:{}",
                if env("GOOGLE_CLOUD_PROJECT").is_empty() {
                    env("GCLOUD_PROJECT")
                } else {
                    env("GOOGLE_CLOUD_PROJECT")
                },
                env("GOOGLE_CLOUD_LOCATION"),
                if env("GOOGLE_APPLICATION_CREDENTIALS").is_empty() {
                    "application-default".to_string()
                } else {
                    env("GOOGLE_APPLICATION_CREDENTIALS")
                }
            ),
            other => other.to_string(),
        }
    }
}

/// Fallback key resolver (custom provider configs).
pub type FallbackResolver = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// Deferred value-fingerprint resolver (command keys).
type ValueFingerprintResolver = Arc<dyn Fn() -> Option<String> + Send + Sync>;

pub struct AuthStorage {
    storage: Arc<dyn AuthStorageBackend>,
    oauth: Arc<dyn OAuthIntegration>,
    env_credentials: Arc<dyn EnvCredentialSource>,
    data: AuthStorageData,
    runtime_overrides: HashMap<String, String>,
    stale_auth_sources: HashMap<String, Vec<AuthSourceToken>>,
    fallback_resolver: Option<FallbackResolver>,
    load_error: Option<String>,
    errors: Vec<String>,
}

impl AuthStorage {
    pub fn from_storage(
        storage: Arc<dyn AuthStorageBackend>,
        oauth: Arc<dyn OAuthIntegration>,
    ) -> Self {
        let mut auth = Self {
            storage,
            oauth,
            env_credentials: Arc::new(ProcessEnvCredentials),
            data: AuthStorageData::default(),
            runtime_overrides: HashMap::new(),
            stale_auth_sources: HashMap::new(),
            fallback_resolver: None,
            load_error: None,
            errors: Vec::new(),
        };
        auth.reload();
        auth
    }

    /// File-backed storage at `agentDir/auth.json`.
    pub fn create(agent_dir: impl AsRef<std::path::Path>) -> Self {
        Self::create_with_oauth(agent_dir, Arc::new(NoOAuth))
    }

    /// File-backed storage with an explicit OAuth integration (the MCP
    /// manager uses this so stored `mcp:*` tokens refresh on expiry).
    pub fn create_with_oauth(
        agent_dir: impl AsRef<std::path::Path>,
        oauth: Arc<dyn OAuthIntegration>,
    ) -> Self {
        let backend: Arc<dyn AuthStorageBackend> = Arc::new(
            super::storage::FileAuthStorageBackend::new(agent_dir.as_ref().join("auth.json")),
        );
        Self::from_storage(backend, oauth)
    }

    pub fn in_memory(data: AuthStorageData, oauth: Arc<dyn OAuthIntegration>) -> Self {
        Self::in_memory_with_env_source(data, oauth, Arc::new(ProcessEnvCredentials))
    }

    /// In-memory storage with no ambient environment source: hermetic
    /// resolution for embedded hosts and test harnesses that must pin the
    /// model catalog scope (an ambient provider credential variable such
    /// as `PRIME_API_KEY` cannot make models available through this
    /// storage). Otherwise behaves like [`AuthStorage::in_memory`].
    pub fn in_memory_without_env(data: AuthStorageData, oauth: Arc<dyn OAuthIntegration>) -> Self {
        Self::in_memory_with_env_source(data, oauth, Arc::new(NoEnvCredentials))
    }

    /// In-memory storage with an injected environment source: hermetic
    /// resolution for tests and embedded hosts (no ambient env reads).
    #[cfg(test)]
    pub(crate) fn in_memory_with_env(
        data: AuthStorageData,
        oauth: Arc<dyn OAuthIntegration>,
        env_credentials: Arc<dyn EnvCredentialSource>,
    ) -> Self {
        Self::in_memory_with_env_source(data, oauth, env_credentials)
    }

    fn in_memory_with_env_source(
        data: AuthStorageData,
        oauth: Arc<dyn OAuthIntegration>,
        env_credentials: Arc<dyn EnvCredentialSource>,
    ) -> Self {
        let backend: Arc<dyn AuthStorageBackend> =
            Arc::new(super::storage::InMemoryAuthStorageBackend::default());
        let content = serde_json::to_string_pretty(&data.0).unwrap_or_default();
        backend
            .with_lock(&mut |current| {
                let _ = current;
                Ok(((), Some(content.clone())))
            })
            .ok();
        let mut auth = Self {
            storage: backend,
            oauth,
            env_credentials,
            data: AuthStorageData::default(),
            runtime_overrides: HashMap::new(),
            stale_auth_sources: HashMap::new(),
            fallback_resolver: None,
            load_error: None,
            errors: Vec::new(),
        };
        auth.reload();
        auth
    }

    pub fn load_error(&self) -> Option<&str> {
        self.load_error.as_deref()
    }

    pub fn drain_errors(&mut self) -> Vec<String> {
        std::mem::take(&mut self.errors)
    }

    /// Reload credentials from storage.
    pub fn reload(&mut self) {
        let mut content: Option<String> = None;
        let result = self.storage.with_lock(&mut |current| {
            content = current;
            Ok(((), None))
        });
        match result.and_then(|()| parse_storage_data(content.as_deref())) {
            Ok(data) => {
                self.data = data;
                self.load_error = None;
            }
            Err(error) => {
                self.load_error = Some(error.to_string());
                self.errors.push(error.to_string());
            }
        }
    }

    /// Runtime API-key override (CLI `--api-key`); not persisted.
    pub fn set_runtime_api_key(&mut self, provider: &str, api_key: String) {
        self.clear_stale_auth_source(provider, AuthSource::Runtime);
        self.runtime_overrides.insert(provider.to_string(), api_key);
    }

    pub fn remove_runtime_api_key(&mut self, provider: &str) {
        self.clear_stale_auth_source(provider, AuthSource::Runtime);
        self.runtime_overrides.remove(provider);
    }

    /// Fallback resolver for keys from custom provider configs (models.json).
    pub fn set_fallback_resolver(&mut self, resolver: FallbackResolver) {
        self.fallback_resolver = Some(resolver);
    }

    // -- candidates ----------------------------------------------------------

    fn stored_value_material(&self, credential: &AuthCredential) -> Option<String> {
        match credential {
            AuthCredential::ApiKey { key, .. } => {
                if key.starts_with('!') {
                    let resolved = resolve_config_value_uncached(key)?;
                    Some(format!("api_key:command:{key} {resolved}"))
                } else {
                    Some(format!(
                        "api_key:{key} {}",
                        resolve_config_value(key).unwrap_or_default()
                    ))
                }
            }
            AuthCredential::Oauth {
                access,
                refresh,
                expires,
                ..
            } => {
                let api_key = self
                    .oauth
                    .api_key_for("", credential)
                    .unwrap_or_else(|| access.clone());
                Some(format!(
                    "oauth:{api_key} {} {expires}",
                    refresh.clone().unwrap_or_default()
                ))
            }
            AuthCredential::McpStaticToken { bearer, .. } => {
                Some(format!("mcp_static_token:{bearer}"))
            }
        }
    }

    fn runtime_candidate(&self, provider: &str) -> Option<AuthSourceCandidate> {
        let key = self.runtime_overrides.get(provider)?;
        Some(AuthSourceCandidate {
            source: AuthSource::Runtime,
            configured: true,
            label: None,
            identity_fingerprint: fingerprint(AuthSource::Runtime, "identity:runtime-override"),
            value_fingerprint: Some(fingerprint(
                AuthSource::Runtime,
                &format!("value:runtime-override {key}"),
            )),
            resolve_value_fingerprint: None,
        })
    }

    fn stored_candidate(&self, provider: &str) -> Option<AuthSourceCandidate> {
        let credential = self.data.credential(provider)?;
        let value_material = self.stored_value_material(&credential);
        Some(AuthSourceCandidate {
            source: AuthSource::Stored,
            configured: true,
            label: None,
            identity_fingerprint: fingerprint(AuthSource::Stored, "identity:auth.json"),
            value_fingerprint: value_material.map(|material| {
                fingerprint(AuthSource::Stored, &format!("value:auth.json {material}"))
            }),
            resolve_value_fingerprint: None,
        })
    }

    fn environment_candidate(&self, provider: &str) -> Option<AuthSourceCandidate> {
        let env_keys = self.env_credentials.key_names(provider);
        let api_key = self.env_credentials.api_key(provider)?;
        let label = env_keys
            .as_ref()
            .and_then(|keys| keys.first().cloned())
            .unwrap_or_else(|| "ambient credentials".to_string());
        let identity_material = env_keys
            .and_then(|keys| keys.first().cloned())
            .unwrap_or_else(|| self.env_credentials.ambient_identity_material(provider));
        Some(AuthSourceCandidate {
            source: AuthSource::Environment,
            configured: false,
            label: Some(label),
            identity_fingerprint: fingerprint(
                AuthSource::Environment,
                &format!("identity:{identity_material}"),
            ),
            value_fingerprint: Some(fingerprint(
                AuthSource::Environment,
                &format!("value:{identity_material} {api_key}"),
            )),
            resolve_value_fingerprint: None,
        })
    }

    fn fallback_candidate(&self, provider: &str) -> Option<AuthSourceCandidate> {
        let resolver = self.fallback_resolver.as_ref()?;
        let api_key = resolver(provider)?;
        Some(AuthSourceCandidate {
            source: AuthSource::Fallback,
            configured: false,
            label: Some("custom provider config".to_string()),
            identity_fingerprint: fingerprint(
                AuthSource::Fallback,
                &format!("identity:{provider}"),
            ),
            value_fingerprint: Some(fingerprint(
                AuthSource::Fallback,
                &format!("value:{provider} {api_key}"),
            )),
            resolve_value_fingerprint: None,
        })
    }

    /// Candidate priority: runtime first; prime-inference prefers environment
    /// over stored; everyone else prefers stored over environment; fallback
    /// last.
    fn auth_source_candidates(
        &self,
        provider: &str,
        include_fallback: bool,
    ) -> Vec<AuthSourceCandidate> {
        let fallback = include_fallback
            .then(|| self.fallback_candidate(provider))
            .flatten();
        if provider == PRIME_INFERENCE_PROVIDER_ID {
            vec![
                self.runtime_candidate(provider),
                self.environment_candidate(provider),
                self.stored_candidate(provider),
                fallback,
            ]
        } else {
            vec![
                self.runtime_candidate(provider),
                self.stored_candidate(provider),
                self.environment_candidate(provider),
                fallback,
            ]
        }
        .into_iter()
        .flatten()
        .collect()
    }

    fn matching_stale(
        &self,
        provider: &str,
        candidate: &AuthSourceCandidate,
    ) -> Vec<&AuthSourceToken> {
        self.stale_auth_sources
            .get(provider)
            .map(|stale| {
                stale
                    .iter()
                    .filter(|token| {
                        token.source == candidate.source
                            && token.identity_fingerprint == candidate.identity_fingerprint
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn is_stale(&self, provider: &str, candidate: &AuthSourceCandidate) -> bool {
        let matching = self.matching_stale(provider, candidate);
        if matching.is_empty() {
            return false;
        }
        candidate.resolved_value_fingerprint().is_some_and(|value| {
            matching
                .iter()
                .any(|token| token.value_fingerprint == value)
        })
    }

    fn available_candidate(
        &self,
        provider: &str,
        include_fallback: bool,
    ) -> Option<AuthSourceCandidate> {
        self.auth_source_candidates(provider, include_fallback)
            .into_iter()
            .find(|candidate| !self.is_stale(provider, candidate))
    }

    fn token_for(
        &self,
        provider: &str,
        candidate: &AuthSourceCandidate,
    ) -> Option<AuthSourceToken> {
        Some(AuthSourceToken {
            provider: provider.to_string(),
            source: candidate.source,
            identity_fingerprint: candidate.identity_fingerprint.clone(),
            value_fingerprint: candidate.resolved_value_fingerprint()?,
        })
    }

    // -- public surface ------------------------------------------------------

    pub fn list(&self) -> Vec<String> {
        self.data.keys()
    }

    pub fn has(&self, provider: &str) -> bool {
        self.data.get(provider).is_some()
    }

    /// Any form of auth configured (never refreshes tokens).
    pub fn has_auth(&self, provider: &str) -> bool {
        self.available_candidate(provider, true).is_some()
    }

    /// Status without credential values.
    pub fn get_auth_status(&self, provider: &str) -> AuthStatus {
        let candidates = self.auth_source_candidates(provider, true);
        let mut has_stale = false;
        for candidate in &candidates {
            if self.is_stale(provider, candidate) {
                has_stale = true;
                continue;
            }
            return AuthStatus {
                configured: candidate.configured,
                source: Some(candidate.source),
                label: candidate.label.clone(),
            };
        }
        if has_stale {
            AuthStatus {
                configured: false,
                source: Some(AuthSource::Stale),
                label: Some("expired".to_string()),
            }
        } else {
            AuthStatus::default()
        }
    }

    pub fn get_all(&self) -> AuthStorageData {
        self.data.clone()
    }

    /// Mark the current credential stale (e.g. the server rejected it).
    pub fn mark_auth_stale(&mut self, provider: &str) -> bool {
        let Some(candidate) = self.available_candidate(provider, true) else {
            return false;
        };
        let Some(token) = self.token_for(provider, &candidate) else {
            return false;
        };
        self.mark_auth_source_stale(token)
    }

    pub fn mark_auth_source_stale(&mut self, token: AuthSourceToken) -> bool {
        if token.provider.is_empty() {
            return false;
        }
        let stale = self
            .stale_auth_sources
            .entry(token.provider.clone())
            .or_default();
        if !stale.contains(&token) {
            stale.push(token);
        }
        true
    }

    /// Forget every stale marking for a provider.
    pub fn clear_auth_stale(&mut self, provider: &str) {
        self.stale_auth_sources.remove(provider);
    }

    fn clear_stale_auth_source(&mut self, provider: &str, source: AuthSource) {
        if let Some(stale) = self.stale_auth_sources.get_mut(provider) {
            stale.retain(|token| token.source != source);
            if stale.is_empty() {
                self.stale_auth_sources.remove(provider);
            }
        }
    }

    /// Store a credential for a provider.
    pub fn set(&mut self, provider: &str, credential: AuthCredential) {
        self.persist_provider_change(provider, Some(credential));
    }

    /// Remove a provider's stored credential.
    pub fn remove(&mut self, provider: &str) {
        self.persist_provider_change(provider, None);
    }

    pub fn logout(&mut self, provider: &str) {
        self.remove(provider);
    }

    fn persist_provider_change(&mut self, provider: &str, credential: Option<AuthCredential>) {
        if self.load_error.is_some() {
            return;
        }
        let mut next_credential = credential;
        let result = self.storage.with_lock(&mut |current| {
            let mut data = parse_storage_data(current.as_deref())?;
            match next_credential.take() {
                Some(credential) => data.insert(provider, &credential),
                None => data.remove(provider),
            }
            let content = serde_json::to_string_pretty(&data.0)?;
            Ok(((), Some(content)))
        });
        if let Err(error) = result {
            self.errors.push(error.to_string());
            return;
        }
        // Reload from what we wrote.
        self.reload();
    }

    /// API-key resolution: runtime > (prime-inference: env) > stored (`api_key`
    /// resolved, oauth refreshed on expiry) > env > fallback. Stale sources
    /// are skipped.
    /// Provider-scoped request headers (prime-inference team header only).
    pub fn get_provider_headers(
        &self,
        provider_id: &str,
    ) -> Option<std::collections::HashMap<String, String>> {
        if provider_id != PRIME_INFERENCE_PROVIDER_ID {
            return None;
        }
        let team_id = self
            .env_credentials
            .prime_team_id()
            .and_then(|value| {
                let trimmed = value.trim().to_string();
                (!trimmed.is_empty()).then_some(trimmed)
            })
            .or_else(|| {
                // Stored team selection: the stored primeTeam survives runtime
                // and environment API-key overrides (fleet P5) — an ambient
                // `PRIME_API_KEY` supplies the key, never the team, so the
                // stored login's team still scopes the header.
                match self.data.credential(provider_id) {
                    Some(AuthCredential::ApiKey { prime_team, .. }) => {
                        prime_team.as_ref().map(|team| team.team_id.clone())
                    }
                    _ => None,
                }
            });
        team_id.map(|team_id| {
            let mut headers = std::collections::HashMap::new();
            headers.insert("X-Prime-Team-ID".to_string(), team_id);
            headers
        })
    }

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
                        source_token: self.token_for(provider_id, &candidate),
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
                        source_token: self.token_for(provider_id, &candidate),
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
                                source_token: self.token_for(provider_id, &candidate),
                                credential_type: Some("api_key"),
                            };
                        }
                        AuthCredential::Oauth { expires, .. } => {
                            let now_ms = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map_or(i64::MAX, |d| d.as_millis() as i64);
                            if now_ms >= *expires {
                                // Refresh under the backend lock.
                                if let Some(refreshed) = self.refresh_oauth(provider_id) {
                                    let candidate = self.stored_candidate(provider_id);
                                    return AuthApiKeyResult {
                                        api_key: self.oauth.api_key_for(provider_id, &refreshed),
                                        source_token: candidate
                                            .and_then(|c| self.token_for(provider_id, &c)),
                                        credential_type: Some("oauth"),
                                    };
                                }
                                // Refresh failed: keep credentials for a
                                // later retry; discovery skips the provider.
                                return AuthApiKeyResult::default();
                            }
                            return AuthApiKeyResult {
                                api_key: self.oauth.api_key_for(provider_id, &credential),
                                source_token: self.token_for(provider_id, &candidate),
                                credential_type: Some("oauth"),
                            };
                        }
                        // A pasted MCP static token IS the api key for its
                        // `mcp:<server>` provider: the bearer value, used
                        // verbatim (no resolution, no expiry).
                        AuthCredential::McpStaticToken { bearer, .. } => {
                            return AuthApiKeyResult {
                                api_key: Some(bearer.clone()),
                                source_token: self.token_for(provider_id, &candidate),
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
                        source_token: self.token_for(provider_id, &candidate),
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
                        source_token: self.token_for(provider_id, &candidate),
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

    /// Refresh an expired OAuth credential under the backend lock, returning
    /// the new credential on success.
    fn refresh_oauth(&mut self, provider_id: &str) -> Option<AuthCredential> {
        let mut refreshed: Option<AuthCredential> = None;
        let result = self.storage.with_lock(&mut |current| {
            let mut data = parse_storage_data(current.as_deref())?;
            let Some(credential) = data.credential(provider_id) else {
                return Ok(((), None));
            };
            let AuthCredential::Oauth { expires, .. } = &credential else {
                return Ok(((), None));
            };
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(i64::MAX, |d| d.as_millis() as i64);
            if now_ms < *expires {
                refreshed = Some(credential);
                return Ok(((), None));
            }
            let Some(new_credential) = self.oauth.refresh(provider_id, &data) else {
                return Ok(((), None));
            };
            data.insert(provider_id, &new_credential);
            refreshed = Some(new_credential);
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
        if result.is_ok() {
            // Reload from what we wrote: the in-memory snapshot must not
            // serve the pre-refresh credential to a later read (a rotated
            // refresh token is single-use).
            self.reload();
        }
        refreshed
    }

    // ------------------------------------------------------------------
    // Prime Inference credential writes (TS `setPrimeInferenceApiKey` /
    // `setPrimeInferenceTeamSelection` / `getPrimeInferenceTeamSelection`).
    // They stay on AuthStorage: the impl owns the private lock and reload
    // machinery they wrap.
    // ------------------------------------------------------------------

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
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixed environment credential source: hermetic against the ambient
    /// process env (e.g. this sandbox exports `PRIME_API_KEY` globally).
    struct ScriptedEnv(HashMap<String, String>);

    impl EnvCredentialSource for ScriptedEnv {
        fn key_names(&self, provider: &str) -> Option<Vec<String>> {
            let names = pa_ai::env_api_keys::get_api_key_env_vars(provider)?
                .into_iter()
                .filter(|name| self.0.get(*name).is_some_and(|value| !value.is_empty()))
                .map(str::to_string)
                .collect::<Vec<_>>();
            (!names.is_empty()).then_some(names)
        }

        fn api_key(&self, provider: &str) -> Option<String> {
            let first = self.key_names(provider)?.first()?.clone();
            self.0.get(&first).cloned().filter(|v| !v.is_empty())
        }

        fn prime_team_id(&self) -> Option<String> {
            self.0.get("PRIME_TEAM_ID").cloned()
        }

        fn ambient_identity_material(&self, provider: &str) -> String {
            format!("{provider}:scripted-ambient")
        }
    }

    fn storage_with(data: serde_json::Value) -> AuthStorage {
        storage_with_env(data, ScriptedEnv(HashMap::new()))
    }

    fn storage_with_env(data: serde_json::Value, env: ScriptedEnv) -> AuthStorage {
        let data = AuthStorageData(data.as_object().cloned().unwrap_or_default());
        AuthStorage::in_memory_with_env(data, Arc::new(NoOAuth), Arc::new(env))
    }

    #[test]
    fn runtime_override_wins() {
        // Non-prime provider: runtime beats stored; ambient env of the test
        // process cannot interfere (stored outranks env for these).
        let mut auth = storage_with(serde_json::json!({
            "anthropic": { "type": "api_key", "key": "stored-key" }
        }));
        assert_eq!(auth.get_api_key("anthropic").as_deref(), Some("stored-key"));
        auth.set_runtime_api_key("anthropic", "runtime-key".to_string());
        assert_eq!(
            auth.get_api_key("anthropic").as_deref(),
            Some("runtime-key")
        );
        auth.remove_runtime_api_key("anthropic");
        assert_eq!(auth.get_api_key("anthropic").as_deref(), Some("stored-key"));
    }

    #[test]
    fn stale_marking_skips_source_and_clears() {
        let mut auth = storage_with(serde_json::json!({
            "prime-inference": { "type": "api_key", "key": "sk-stale" }
        }));
        assert!(auth.mark_auth_stale("prime-inference"));
        // The stored credential is now skipped.
        assert_eq!(auth.get_api_key("prime-inference"), None);
        let status = auth.get_auth_status("prime-inference");
        assert_eq!(status.source, Some(AuthSource::Stale));
        // Explicit clear re-enables it.
        auth.clear_auth_stale("prime-inference");
        assert_eq!(
            auth.get_api_key("prime-inference").as_deref(),
            Some("sk-stale")
        );
    }

    #[test]
    fn set_and_remove_credentials() {
        let mut auth = storage_with(serde_json::json!({}));
        auth.set(
            "anthropic",
            AuthCredential::ApiKey {
                key: "sk-ant".into(),
                prime_team: None,
            },
        );
        assert!(auth.has("anthropic"));
        assert!(auth.has_auth("anthropic"));
        assert_eq!(auth.get_api_key("anthropic").as_deref(), Some("sk-ant"));
        // The generic `set` keeps the TS omit shape: a non-prime key
        // carries no `primeTeam` property.
        assert!(!auth
            .get_all()
            .get("anthropic")
            .unwrap()
            .as_object()
            .unwrap()
            .contains_key("primeTeam"));
        auth.logout("anthropic");
        assert!(!auth.has("anthropic"));
        assert_eq!(auth.get_api_key("anthropic"), None);
    }

    #[test]
    fn command_keys_resolve() {
        let mut auth = storage_with(serde_json::json!({
            "anthropic": { "type": "api_key", "key": "!echo cmd-key" }
        }));
        assert_eq!(auth.get_api_key("anthropic").as_deref(), Some("cmd-key"));
    }

    #[test]
    fn env_key_priority_for_prime_inference() {
        // prime-inference prefers the environment over stored.
        let mut auth = storage_with_env(
            serde_json::json!({
                "prime-inference": { "type": "api_key", "key": "stored-key" }
            }),
            ScriptedEnv(HashMap::from([(
                "PRIME_API_KEY".to_string(),
                "env-key".to_string(),
            )])),
        );
        assert_eq!(
            auth.get_api_key("prime-inference").as_deref(),
            Some("env-key")
        );
    }

    #[test]
    fn fallback_resolver_last_resort() {
        let mut auth = storage_with(serde_json::json!({}));
        auth.set_fallback_resolver(Arc::new(|provider| {
            (provider == "custom").then(|| "fb-key".to_string())
        }));
        assert_eq!(auth.get_api_key("custom").as_deref(), Some("fb-key"));
    }

    #[test]
    fn provider_headers_team_selection() {
        let auth = storage_with(serde_json::json!({
            "prime-inference": {
                "type": "api_key",
                "key": "pi-key",
                "primeTeam": { "teamId": "team-1", "name": "Team 1" }
            }
        }));
        // Stored team selection surfaces as the team header.
        let headers = auth
            .get_provider_headers(PRIME_INFERENCE_PROVIDER_ID)
            .unwrap();
        assert_eq!(
            headers.get("X-Prime-Team-ID").map(String::as_str),
            Some("team-1")
        );
        // Other providers have no headers.
        assert!(auth.get_provider_headers("anthropic").is_none());
        // The stored team survives an ambient environment key (the dogfood
        // box posture): PRIME_API_KEY supplies the key, the stored login's
        // team still scopes the header.
        let mut auth = storage_with_env(
            serde_json::json!({
                "prime-inference": {
                    "type": "api_key",
                    "key": "pi-key",
                    "primeTeam": { "teamId": "team-1", "name": "Team 1" }
                }
            }),
            ScriptedEnv(HashMap::from([(
                "PRIME_API_KEY".to_string(),
                "env-key".to_string(),
            )])),
        );
        assert_eq!(
            auth.get_api_key(PRIME_INFERENCE_PROVIDER_ID).as_deref(),
            Some("env-key")
        );
        let headers = auth
            .get_provider_headers(PRIME_INFERENCE_PROVIDER_ID)
            .unwrap();
        assert_eq!(
            headers.get("X-Prime-Team-ID").map(String::as_str),
            Some("team-1")
        );
        // The stored team survives a runtime API-key override too.
        let mut auth = storage_with(serde_json::json!({
            "prime-inference": {
                "type": "api_key",
                "key": "pi-key",
                "primeTeam": { "teamId": "team-1", "name": "Team 1" }
            }
        }));
        auth.set_runtime_api_key(PRIME_INFERENCE_PROVIDER_ID, "runtime-key".to_string());
        assert_eq!(
            auth.get_api_key(PRIME_INFERENCE_PROVIDER_ID).as_deref(),
            Some("runtime-key")
        );
        let headers = auth
            .get_provider_headers(PRIME_INFERENCE_PROVIDER_ID)
            .unwrap();
        assert_eq!(
            headers.get("X-Prime-Team-ID").map(String::as_str),
            Some("team-1")
        );
        // PRIME_TEAM_ID env wins over the stored selection.
        let auth = storage_with_env(
            serde_json::json!({
                "prime-inference": {
                    "type": "api_key",
                    "key": "pi-key",
                    "primeTeam": { "teamId": "team-1", "name": "Team 1" }
                }
            }),
            ScriptedEnv(HashMap::from([(
                "PRIME_TEAM_ID".to_string(),
                "env-team".to_string(),
            )])),
        );
        let headers = auth
            .get_provider_headers(PRIME_INFERENCE_PROVIDER_ID)
            .unwrap();
        assert_eq!(
            headers.get("X-Prime-Team-ID").map(String::as_str),
            Some("env-team")
        );
    }

    fn team(id: &str, name: &str) -> PrimeTeamCredential {
        PrimeTeamCredential {
            team_id: id.to_string(),
            name: name.to_string(),
            slug: None,
            role: None,
            created_at: None,
        }
    }

    #[test]
    fn prime_inference_key_writes_follow_the_ts_assignment_rules() {
        let mut auth = storage_with(serde_json::json!({}));
        // A team write binds the team to the key.
        auth.set_prime_inference_api_key("sk-1", PrimeTeamAssignment::Team(team("1", "Team 1")));
        assert_eq!(
            auth.get_all().credential(PRIME_INFERENCE_PROVIDER_ID),
            Some(AuthCredential::ApiKey {
                key: "sk-1".to_string(),
                prime_team: Some(team("1", "Team 1")),
            })
        );
        // TS `undefined`: the same key preserves the stored team.
        auth.set_prime_inference_api_key("sk-1", PrimeTeamAssignment::PreserveWhenKeyMatches);
        assert_eq!(
            auth.get_all().credential(PRIME_INFERENCE_PROVIDER_ID),
            Some(AuthCredential::ApiKey {
                key: "sk-1".to_string(),
                prime_team: Some(team("1", "Team 1")),
            })
        );
        // TS `undefined`: a different key drops the stored team.
        auth.set_prime_inference_api_key("sk-2", PrimeTeamAssignment::PreserveWhenKeyMatches);
        assert_eq!(
            auth.get_all().credential(PRIME_INFERENCE_PROVIDER_ID),
            Some(AuthCredential::ApiKey {
                key: "sk-2".to_string(),
                prime_team: None,
            })
        );
        // TS `null`: the personal account, explicitly.
        auth.set_prime_inference_api_key("sk-2", PrimeTeamAssignment::Team(team("2", "Team 2")));
        auth.set_prime_inference_api_key("sk-2", PrimeTeamAssignment::PersonalAccount);
        assert_eq!(
            auth.get_all().credential(PRIME_INFERENCE_PROVIDER_ID),
            Some(AuthCredential::ApiKey {
                key: "sk-2".to_string(),
                prime_team: None,
            })
        );
        // The write clears a stale marking on the stored source (TS
        // `clearStaleAuthSource`).
        assert!(auth.mark_auth_stale(PRIME_INFERENCE_PROVIDER_ID));
        auth.set_prime_inference_api_key("sk-3", PrimeTeamAssignment::PersonalAccount);
        assert_eq!(
            auth.get_api_key(PRIME_INFERENCE_PROVIDER_ID).as_deref(),
            Some("sk-3")
        );
        // The stored document carries the TS wire shape: the personal
        // account persists `primeTeam: null` (TS writes the key
        // explicitly), never an omitted field.
        let stored = auth.get_all();
        let credential = stored
            .get(PRIME_INFERENCE_PROVIDER_ID)
            .unwrap()
            .as_object()
            .unwrap();
        assert_eq!(credential.get("primeTeam"), Some(&serde_json::Value::Null));
    }

    #[test]
    fn prime_inference_team_selection_rebinds_only_the_stored_key() {
        let mut auth = storage_with(serde_json::json!({}));
        // Without a stored credential the selection is a no-op.
        auth.set_prime_inference_team_selection(Some(team("1", "Team 1")), None);
        assert_eq!(auth.get_all().get(PRIME_INFERENCE_PROVIDER_ID), None);
        // With the key it rebinds the team; the key must match when the
        // caller pins it.
        auth.set_prime_inference_api_key("sk-1", PrimeTeamAssignment::PersonalAccount);
        auth.set_prime_inference_team_selection(Some(team("1", "Team 1")), Some("sk-1"));
        assert_eq!(
            auth.get_prime_inference_team_selection(),
            StoredPrimeTeam::Team(team("1", "Team 1"))
        );
        auth.set_prime_inference_team_selection(Some(team("2", "Team 2")), Some("wrong-key"));
        assert_eq!(
            auth.get_prime_inference_team_selection(),
            StoredPrimeTeam::Team(team("1", "Team 1"))
        );
        auth.set_prime_inference_team_selection(Some(team("2", "Team 2")), None);
        assert_eq!(
            auth.get_prime_inference_team_selection(),
            StoredPrimeTeam::Team(team("2", "Team 2"))
        );
        auth.set_prime_inference_team_selection(None, None);
        assert_eq!(
            auth.get_prime_inference_team_selection(),
            StoredPrimeTeam::PersonalAccount
        );
        // A non-api-key credential is never rebound.
        let mut auth = storage_with(serde_json::json!({
            "prime-inference": {
                "type": "oauth", "access": "a", "refresh": null, "expires": 1
            }
        }));
        auth.set_prime_inference_team_selection(Some(team("1", "Team 1")), None);
        assert_eq!(
            auth.get_all().get(PRIME_INFERENCE_PROVIDER_ID).unwrap()["access"],
            "a"
        );
    }

    /// A backend that serves reads but fails every write (the locked
    /// write erroring before the reload, storage.rs's failure arm).
    struct WriteFailingBackend(std::sync::Mutex<Option<String>>);

    impl AuthStorageBackend for WriteFailingBackend {
        fn with_lock(
            &self,
            update: &mut dyn FnMut(Option<String>) -> anyhow::Result<((), Option<String>)>,
        ) -> anyhow::Result<()> {
            let current = self.0.lock().unwrap().clone();
            let ((), next) = update(current)?;
            match next {
                Some(_) => Err(anyhow::anyhow!("the locked write failed")),
                None => Ok(()),
            }
        }
    }

    #[test]
    fn a_failed_prime_inference_key_write_keeps_the_stale_marking() {
        // TS: `setPrimeInferenceApiKey` throws before
        // `clearStaleAuthSource`, so a failed replacement never re-enables
        // the server-rejected credential.
        let mut auth = AuthStorage::from_storage(
            Arc::new(WriteFailingBackend(std::sync::Mutex::new(Some(
                r#"{"prime-inference": {"type": "api_key", "key": "sk-rejected"}}"#.to_string(),
            )))),
            Arc::new(NoOAuth),
        );
        // The scripted empty env keeps the stored credential the active
        // source (an ambient PRIME_API_KEY would outrank it for
        // prime-inference and change what `mark_auth_stale` marks).
        auth.env_credentials = Arc::new(ScriptedEnv(HashMap::new()));
        assert!(auth.mark_auth_stale(PRIME_INFERENCE_PROVIDER_ID));
        auth.set_prime_inference_api_key("sk-new", PrimeTeamAssignment::PersonalAccount);
        assert!(
            !auth.drain_errors().is_empty(),
            "the failed write surfaces its error"
        );
        // The rejected credential stays stale: the failed replacement
        // did not re-enable it.
        assert_eq!(
            auth.get_auth_status(PRIME_INFERENCE_PROVIDER_ID).source,
            Some(AuthSource::Stale)
        );
        assert_eq!(auth.get_api_key(PRIME_INFERENCE_PROVIDER_ID), None);
    }

    #[test]
    fn prime_inference_team_selection_reads_follow_the_ts_tri_state() {
        // No credential: no selection.
        let auth = storage_with(serde_json::json!({}));
        assert_eq!(
            auth.get_prime_inference_team_selection(),
            StoredPrimeTeam::NotSelected
        );
        // A stored team selection reads back.
        let auth = storage_with(serde_json::json!({
            "prime-inference": {
                "type": "api_key",
                "key": "pi-key",
                "primeTeam": { "teamId": "team-1", "name": "Team 1" }
            }
        }));
        assert_eq!(
            auth.get_prime_inference_team_selection(),
            StoredPrimeTeam::Team(team("team-1", "Team 1"))
        );
        // A stored personal account reads back.
        let auth = storage_with(serde_json::json!({
            "prime-inference": {
                "type": "api_key", "key": "pi-key", "primeTeam": null
            }
        }));
        assert_eq!(
            auth.get_prime_inference_team_selection(),
            StoredPrimeTeam::PersonalAccount
        );
        // PRIME_TEAM_ID hides the stored selection (the env pin owns the
        // team).
        let auth = storage_with_env(
            serde_json::json!({
                "prime-inference": {
                    "type": "api_key", "key": "pi-key", "primeTeam": null
                }
            }),
            ScriptedEnv(HashMap::from([(
                "PRIME_TEAM_ID".to_string(),
                "env-team".to_string(),
            )])),
        );
        assert_eq!(
            auth.get_prime_inference_team_selection(),
            StoredPrimeTeam::NotSelected
        );
        // An environment key (the active source for prime-inference) does
        // NOT hide the stored selection: the stored primeTeam survives the
        // override (fleet P5, the dogfood daemon posture — no PRIME_TEAM_ID
        // pin needed).
        let auth = storage_with_env(
            serde_json::json!({
                "prime-inference": {
                    "type": "api_key",
                    "key": "pi-key",
                    "primeTeam": { "teamId": "team-1", "name": "Team 1" }
                }
            }),
            ScriptedEnv(HashMap::from([(
                "PRIME_API_KEY".to_string(),
                "env-key".to_string(),
            )])),
        );
        assert_eq!(
            auth.get_prime_inference_team_selection(),
            StoredPrimeTeam::Team(team("team-1", "Team 1"))
        );
        // A runtime override (the active source) does not hide it either.
        let mut auth = storage_with(serde_json::json!({
            "prime-inference": {
                "type": "api_key",
                "key": "pi-key",
                "primeTeam": { "teamId": "team-1", "name": "Team 1" }
            }
        }));
        auth.set_runtime_api_key(PRIME_INFERENCE_PROVIDER_ID, "runtime-key".to_string());
        assert_eq!(
            auth.get_prime_inference_team_selection(),
            StoredPrimeTeam::Team(team("team-1", "Team 1"))
        );
    }
}
