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

// The inline unit battery moved to the child module at the same tree
// position (auth::manager::tests); its use-super glob keeps resolving
// through the facade bindings and re-exports (the manager stage-1
// precedent, #3039).
#[cfg(test)]
mod tests;

// The API-key lookup + OAuth refresh arm (get_api_key_with_source_token,
// get_api_key, refresh_oauth) moved to the child module at the same tree
// position (auth::manager::lookup) as its own impl AuthStorage block -
// inherent impls split freely; the pub methods stay on the facade-
// resident type (external callers resolve through the type; the
// agent_traces engine's get_api_key_with_source_token call checked);
// refresh_oauth keeps its private level (the lookup child is its only
// caller - zero pub(super) bumps, verified by the caller map); the
// child's bare calls into the facade's candidate/staleness machinery
// resolve through the use-super glob (the descendant visibility rule).
mod lookup;

// The Prime Inference credential writes (update_prime_inference_credential,
// set_prime_inference_api_key, set_prime_inference_team_selection,
// get_prime_inference_team_selection) moved to the child module at the
// same tree position (auth::manager::prime_inference) as its own impl
// AuthStorage block; the pub methods stay on the facade-resident type and
// update_prime_inference_credential keeps its private level (the child is
// its only caller - ZERO pub(super) bumps, verified by the caller map);
// the child wraps the facade's private lock + reload machinery through the
// use-super glob.
mod prime_inference;

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

/// Wall-clock milliseconds since the epoch (auth expiry comparison).
fn now_epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(i64::MAX, |d| d.as_millis() as i64)
}

/// One OAuth refresh in flight per provider: the token fetch in
/// [`AuthStorage::refresh_oauth`] runs outside every lock, so the
/// in-process single-flight that TS gets from its single-threaded runtime
/// needs its own gate. The registry mirrors the storage backend's
/// process-lock registry (created once, lives for the process, recovered
/// on poisoning).
fn refresh_flight(provider: &str) -> std::sync::MutexGuard<'static, ()> {
    static FLIGHTS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, &'static std::sync::Mutex<()>>>,
    > = std::sync::OnceLock::new();
    let registry = FLIGHTS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    let lock = {
        let mut registry = registry.lock().expect("auth refresh-flight registry");
        *registry
            .entry(provider.to_string())
            .or_insert_with(|| Box::leak(Box::new(std::sync::Mutex::new(()))))
    };
    lock.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
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
    /// Memoized auth-source candidates (TS #2479's `authCandidateMemos`),
    /// keyed by `source:provider`, superseded exactly when the candidate's
    /// hashed material changes. Reuse skips only the SHA-256 work: the
    /// material itself (env reads, stored-value resolution, the fallback
    /// resolver) is recomputed on every call, and stale checks run against
    /// the memoized candidate — candidates are immutable.
    candidate_memos: std::sync::Mutex<HashMap<String, (String, AuthSourceCandidate)>>,
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
            candidate_memos: std::sync::Mutex::new(HashMap::new()),
        };
        auth.reload();
        auth
    }

    /// File-backed storage at `agentDir/auth.json`.
    pub fn create(agent_dir: impl AsRef<std::path::Path>) -> Self {
        // The built-in subscription providers' integration (the codex
        // refresh): the TS storage delegates to the AI library's oauth
        // registry on every instance, and `api_key_for` matches `NoOAuth`
        // (the access token passthrough), so only token refresh gains.
        Self::create_with_oauth(
            agent_dir,
            Arc::new(super::provider_oauth::ProviderOAuth::new()),
        )
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

    pub fn in_memory(data: &AuthStorageData, oauth: Arc<dyn OAuthIntegration>) -> Self {
        Self::in_memory_with_env_source(data, oauth, Arc::new(ProcessEnvCredentials))
    }

    /// In-memory storage with no ambient environment source: hermetic
    /// resolution for embedded hosts and test harnesses that must pin the
    /// model catalog scope (an ambient provider credential variable such
    /// as `PRIME_API_KEY` cannot make models available through this
    /// storage). Otherwise behaves like [`AuthStorage::in_memory`].
    pub fn in_memory_without_env(data: &AuthStorageData, oauth: Arc<dyn OAuthIntegration>) -> Self {
        Self::in_memory_with_env_source(data, oauth, Arc::new(NoEnvCredentials))
    }

    /// In-memory storage with an injected environment source: hermetic
    /// resolution for tests and embedded hosts (no ambient env reads).
    #[cfg(test)]
    pub(crate) fn in_memory_with_env(
        data: &AuthStorageData,
        oauth: Arc<dyn OAuthIntegration>,
        env_credentials: Arc<dyn EnvCredentialSource>,
    ) -> Self {
        Self::in_memory_with_env_source(data, oauth, env_credentials)
    }

    fn in_memory_with_env_source(
        data: &AuthStorageData,
        oauth: Arc<dyn OAuthIntegration>,
        env_credentials: Arc<dyn EnvCredentialSource>,
    ) -> Self {
        let backend: Arc<dyn AuthStorageBackend> =
            Arc::new(crate::auth::storage::InMemoryAuthStorageBackend::default());
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
            candidate_memos: std::sync::Mutex::new(HashMap::new()),
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
        // The pure-read arm: a locked protocol read on any cache miss, the
        // process-cached copy on a hit (see `AuthStorageBackend::read`).
        let result = self.storage.read();
        match result.and_then(|content| parse_storage_data(content.as_deref())) {
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

    /// Memo marker for candidates whose value material could not be
    /// resolved into a key (TS #2479's `AUTH_SOURCE_LAZY_VALUE_KEY`): the
    /// entry is keyed by everything else the candidate hashes.
    fn auth_source_lazy_value_key() -> &'static str {
        "value-lazy"
    }

    /// The memo reuse arm (TS #2479's `reuseAuthSourceCandidate`): the key
    /// is the hashed material itself, so the memo is superseded exactly
    /// when the material is.
    fn reuse_auth_source_candidate(
        &self,
        source: AuthSource,
        provider: &str,
        key: String,
        build: impl FnOnce() -> AuthSourceCandidate,
    ) -> AuthSourceCandidate {
        let memo_slot = format!("{source:?}:{provider}");
        let mut memos = self
            .candidate_memos
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((memo_key, candidate)) = memos.get(&memo_slot) {
            if memo_key == &key {
                return candidate.clone();
            }
        }
        let candidate = build();
        memos.insert(memo_slot, (key, candidate.clone()));
        candidate
    }

    fn runtime_candidate(&self, provider: &str) -> Option<AuthSourceCandidate> {
        let key = self.runtime_overrides.get(provider)?.clone();
        Some(self.reuse_auth_source_candidate(
            AuthSource::Runtime,
            provider,
            key.clone(),
            move || AuthSourceCandidate {
                source: AuthSource::Runtime,
                configured: true,
                label: None,
                identity_fingerprint: fingerprint(AuthSource::Runtime, "identity:runtime-override"),
                value_fingerprint: Some(fingerprint(
                    AuthSource::Runtime,
                    &format!("value:runtime-override {key}"),
                )),
                resolve_value_fingerprint: None,
            },
        ))
    }

    fn stored_candidate(&self, provider: &str) -> Option<AuthSourceCandidate> {
        let credential = self.data.credential(provider)?;
        let value_material = self.stored_value_material(&credential);
        // The key is the hashed material itself (TS #2479: keyed by
        // credential fields, never object identity, so the key
        // changes exactly when the hashed material does).
        let key = format!(
            "identity:auth.json {}",
            value_material
                .as_deref()
                .unwrap_or(Self::auth_source_lazy_value_key()),
        );
        Some(
            self.reuse_auth_source_candidate(AuthSource::Stored, provider, key, || {
                AuthSourceCandidate {
                    source: AuthSource::Stored,
                    configured: true,
                    label: None,
                    identity_fingerprint: fingerprint(AuthSource::Stored, "identity:auth.json"),
                    value_fingerprint: value_material.map(|material| {
                        fingerprint(AuthSource::Stored, &format!("value:auth.json {material}"))
                    }),
                    resolve_value_fingerprint: None,
                }
            }),
        )
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
        // Env values are deliberately re-read on every call (TS
        // #2479); the memo only skips re-fingerprinting unchanged
        // material.
        let key = format!("{identity_material} {api_key}");
        Some(
            self.reuse_auth_source_candidate(AuthSource::Environment, provider, key, || {
                AuthSourceCandidate {
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
                }
            }),
        )
    }

    fn fallback_candidate(&self, provider: &str) -> Option<AuthSourceCandidate> {
        let resolver = self.fallback_resolver.as_ref()?;
        let api_key = resolver(provider)?;
        Some(self.reuse_auth_source_candidate(
            AuthSource::Fallback,
            provider,
            api_key.clone(),
            || AuthSourceCandidate {
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
            },
        ))
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

    fn token_for(provider: &str, candidate: &AuthSourceCandidate) -> Option<AuthSourceToken> {
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
        let Some(token) = Self::token_for(provider, &candidate) else {
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
}
