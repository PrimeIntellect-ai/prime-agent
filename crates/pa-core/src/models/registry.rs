//! ModelRegistry: composes built-in, custom (models.json), and Prime Inference
//! catalogs; resolves request auth per provider/model. Port of model-registry.ts.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use pa_types::ai::Model;

use crate::auth::manager::AuthStorage;
use crate::auth::types::PRIME_INFERENCE_PROVIDER_ID;

use super::catalog_chain;
use super::custom::{apply_model_override, load_custom_models, merge_compat, CustomModelsResult};
use super::prime_inference::is_private_prime_inference_model;
use super::private_auth::{
    fetch_authorized_private_prime_inference_models, is_offline_mode_enabled,
    private_prime_authorization_fingerprint, read_private_prime_authorization_cache,
    write_private_prime_authorization_cache, PrivatePrimeAuthorizationCache,
    PRIVATE_BACKGROUND_TIMEOUT_MS, PRIVATE_MODEL_TIMEOUT_MS,
    PRIVATE_PRIME_AUTHORIZATION_CACHE_TTL_MS,
};

/// Request-auth bits a provider can configure in models.json.
#[derive(Debug, Clone, Default)]
pub struct ProviderRequestConfig {
    pub api_key: Option<String>,
    /// Ordered (`BTreeMap`): these headers merge into request-header maps
    /// that providers iterate deterministically.
    pub headers: Option<BTreeMap<String, String>>,
    pub auth_header: Option<bool>,
}

/// The result of `getApiKeyAndHeaders`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ResolvedRequestAuth {
    pub ok: bool,
    pub api_key: Option<String>,
    /// Ordered (`BTreeMap`): providers iterate this map when composing
    /// request headers, and unordered iteration would order them randomly.
    pub headers: Option<BTreeMap<String, String>>,
    pub error: Option<String>,
}

/// Composed model catalog with auth-aware availability.
pub struct ModelRegistry {
    pub auth: AuthStorage,
    models_json_path: Option<PathBuf>,
    models: Vec<Model>,
    load_error: Option<String>,
    provider_request_configs: HashMap<String, ProviderRequestConfig>,
    model_request_headers: HashMap<String, BTreeMap<String, String>>,
    explicit_private_ids: HashSet<String>,
    authorized_private_ids: HashSet<String>,
    authorized_private_models: Vec<Model>,
    authorized_team_id: Option<String>,
    /// The process-shared live catalog chain (`catalog_chain::catalog_for`):
    /// resolve() sources built-ins from it.
    catalog: std::sync::Arc<pa_models::ModelCatalog>,
}

impl ModelRegistry {
    pub fn create(auth: AuthStorage, models_json_path: impl Into<PathBuf>) -> Self {
        Self::new(auth, Some(models_json_path.into()))
    }

    pub fn in_memory(auth: AuthStorage) -> Self {
        Self::new(auth, None)
    }

    fn new(auth: AuthStorage, models_json_path: Option<PathBuf>) -> Self {
        let catalog = catalog_chain::catalog_for(models_json_path.as_deref());
        let mut registry = Self {
            auth,
            models_json_path,
            models: Vec::new(),
            load_error: None,
            provider_request_configs: HashMap::new(),
            model_request_headers: HashMap::new(),
            explicit_private_ids: HashSet::new(),
            authorized_private_ids: HashSet::new(),
            authorized_private_models: Vec::new(),
            authorized_team_id: None,
            catalog,
        };
        registry.load_models();
        registry
    }

    /// The Prime Inference credentials for the credentialed catalog layer
    /// (the TS `refreshPrimeInferenceModels` headers: Bearer + team).
    fn prime_credentials(&mut self) -> Option<pa_models::PrimeCredentials> {
        let api_key = self.auth.get_api_key(PRIME_INFERENCE_PROVIDER_ID)?;
        let team_id = self
            .auth
            .get_provider_headers(PRIME_INFERENCE_PROVIDER_ID)
            .and_then(|headers| headers.get("X-Prime-Team-ID").cloned());
        Some(pa_models::PrimeCredentials { api_key, team_id })
    }

    /// Error from loading models.json, if any.
    pub fn get_error(&self) -> Option<&str> {
        self.load_error.as_deref()
    }

    /// Built-in + custom models (auth not filtered).
    pub fn get_all(&self) -> &[Model] {
        &self.models
    }

    /// Models whose provider has configured auth, with unauthorized private
    /// Prime Inference models gated out (TS `getAvailable`).
    pub fn get_available(&self) -> Vec<&Model> {
        self.models
            .iter()
            .filter(|model| {
                (!is_private_prime_inference_model(model)
                    || self.is_authorized_private_model(model))
                    && self.has_configured_auth(model)
            })
            .collect()
    }

    /// Models `rlm.find_models` may search: auth-configured, and not on a
    /// stale or expired provider credential.
    pub fn get_rlm_searchable_models(&self) -> Vec<&Model> {
        self.get_available()
            .into_iter()
            .filter(|model| {
                let status = self.auth.get_auth_status(&model.provider);
                status.source != Some(crate::auth::types::AuthSource::Stale)
                    && status.label.as_deref() != Some("expired")
            })
            .collect()
    }

    pub fn has_configured_auth(&self, model: &Model) -> bool {
        self.auth.has_auth(&model.provider)
            || self.has_configured_provider_request_auth(&model.provider)
    }

    fn has_configured_provider_request_auth(&self, provider: &str) -> bool {
        let Some(config) = self.provider_request_configs.get(provider) else {
            return false;
        };
        if config.headers.is_some() || config.auth_header.is_some() {
            return true;
        }
        config.api_key.as_deref().is_some_and(|key| {
            crate::auth::resolve_config_value::resolve_config_value(key).is_some()
        })
    }

    /// Reload built-in + custom models and provider request configs from disk.
    /// Adopt the on-disk private Prime Inference authorization cache without
    /// any network access. Sync callers that resolve models on a fresh
    /// registry (daemon create-path, headless print) must call this before
    /// `get_available`; a fresh registry otherwise gates every private model
    /// out because only the async refresh populates the authorized set.
    pub fn load_private_authorization_from_cache(&mut self) {
        let api_key = self.auth.get_api_key(PRIME_INFERENCE_PROVIDER_ID);
        let team_headers = self.auth.get_provider_headers(PRIME_INFERENCE_PROVIDER_ID);
        let team_id = team_headers
            .as_ref()
            .and_then(|headers| headers.get("X-Prime-Team-ID").cloned());
        let (Some(api_key), Some(team_id)) = (api_key, team_id) else {
            return;
        };
        let fingerprint = private_prime_authorization_fingerprint(&api_key, &team_id);
        let Some(models_json_path) = self.models_json_path.clone() else {
            return;
        };
        let Some(PrivatePrimeAuthorizationCache {
            fingerprint: cached_fingerprint,
            models,
            refreshed_at: _,
        }) = read_private_prime_authorization_cache(&models_json_path)
        else {
            return;
        };
        if cached_fingerprint != fingerprint {
            return;
        }
        self.authorized_private_models = models;
        self.authorized_private_ids = self
            .authorized_private_models
            .iter()
            .map(|model| model.id.clone())
            .collect();
        self.authorized_team_id = Some(team_id);
        self.load_models();
    }

    pub fn refresh(&mut self) {
        self.provider_request_configs.clear();
        self.model_request_headers.clear();
        self.explicit_private_ids.clear();
        self.load_error = None;
        self.auth.reload();
        // Direct refreshes invalidate changed auth immediately but preserve
        // same-team stale recovery.
        let team_id = self
            .auth
            .get_provider_headers(PRIME_INFERENCE_PROVIDER_ID)
            .and_then(|headers| headers.get("X-Prime-Team-ID").cloned());
        let stale_status = matches!(
            self.auth
                .get_auth_status(PRIME_INFERENCE_PROVIDER_ID)
                .source,
            Some(crate::auth::types::AuthSource::Stale)
        );
        if !stale_status || team_id.is_none() || team_id != self.authorized_team_id {
            self.authorized_private_ids.clear();
            self.authorized_private_models.clear();
            self.authorized_team_id = None;
        }
        self.load_models();
    }

    fn load_models(&mut self) {
        let path = self.models_json_path.clone();
        let result = match &path {
            Some(path) => self.load_custom_models_file(path),
            None => CustomModelsResult::default(),
        };
        if let Some(error) = &result.error {
            self.load_error = Some(error.clone());
        }
        self.explicit_private_ids = result
            .models
            .iter()
            .filter(|model| is_private_prime_inference_model(model))
            .map(|model| model.id.clone())
            .collect();

        // Private models: bundled table + authorized set, deduped by id.
        let mut private_models: HashMap<String, Model> = HashMap::new();
        for model in super::private_auth::get_private_prime_inference_models() {
            private_models.insert(model.id.clone(), model);
        }
        for model in &self.authorized_private_models {
            private_models.insert(model.id.clone(), model.clone());
        }

        let credentials = self.prime_credentials();
        let mut built_in = self.load_built_in_models(&result, credentials.as_ref());
        built_in.extend(private_models.into_values());
        self.models = self.merge_custom_models(built_in, result.models);
    }

    fn load_custom_models_file(&mut self, path: &Path) -> CustomModelsResult {
        if !path.exists() {
            return CustomModelsResult::default();
        }
        let Ok(content) = std::fs::read_to_string(path) else {
            return CustomModelsResult {
                error: Some(format!(
                    "Failed to load models.json\n\nFile: {}",
                    path.display()
                )),
                ..Default::default()
            };
        };
        let mut result = load_custom_models(
            &content,
            &|provider| !pa_ai::models_generated::get_models(provider).is_empty(),
            &|provider| {
                pa_ai::models_generated::get_models(provider)
                    .first()
                    .map(|model| (model.api.clone(), model.base_url.clone()))
            },
        );
        // Provider/model request config from the parsed document.
        if result.error.is_none() {
            if let Ok(config) =
                super::custom::parse_models_config(&super::custom::strip_json_comments(&content))
            {
                for (provider, provider_config) in config.providers {
                    if provider_config.api_key.is_some()
                        || provider_config.headers.is_some()
                        || provider_config.auth_header.is_some()
                    {
                        self.provider_request_configs.insert(
                            provider.clone(),
                            ProviderRequestConfig {
                                api_key: provider_config.api_key,
                                headers: provider_config.headers,
                                auth_header: provider_config.auth_header,
                            },
                        );
                    }
                    if let Some(model_overrides) = provider_config.model_overrides {
                        for (model_id, model_override) in model_overrides {
                            self.store_model_headers(
                                &provider,
                                &model_id,
                                model_override.headers.clone(),
                            );
                        }
                    }
                    if let Some(model_defs) = provider_config.models {
                        for model_def in model_defs {
                            self.store_model_headers(
                                &provider,
                                &model_def.id,
                                model_def.headers.clone(),
                            );
                        }
                    }
                }
            }
        }
        if let Some(error) = &result.error {
            // Keep built-ins only; message mirrors the TS load failure format.
            if !error.contains("models.json") {
                result.error = Some(format!("{error}\n\nFile: {}", path.display()));
            }
        }
        result
    }

    fn store_model_headers(
        &mut self,
        provider: &str,
        model_id: &str,
        headers: Option<BTreeMap<String, String>>,
    ) {
        let key = format!("{provider}:{model_id}");
        match headers {
            Some(headers) if !headers.is_empty() => {
                self.model_request_headers.insert(key, headers);
            }
            _ => {
                self.model_request_headers.remove(&key);
            }
        }
    }

    /// Built-ins through the no-cold-start chain (validated disk snapshot |
    /// bundled asset | compiled fallback), merged with the credentialed
    /// live Prime Inference snapshot for `credentials` — TS
    /// `loadBuiltInModels` over the provider catalog + `livePrimeInferenceModels`.
    fn load_built_in_models(
        &self,
        custom: &CustomModelsResult,
        credentials: Option<&pa_models::PrimeCredentials>,
    ) -> Vec<Model> {
        self.catalog
            .resolve(credentials)
            .into_iter()
            .map(|mut model| {
                if let Some(provider_override) = custom.provider_overrides.get(&model.provider) {
                    if provider_override.base_url.is_some() {
                        model.base_url = provider_override
                            .base_url
                            .clone()
                            .unwrap_or_else(|| model.base_url.clone());
                    }
                    if provider_override.compat.is_some() {
                        model.compat =
                            merge_compat(model.compat.as_ref(), provider_override.compat.clone());
                    }
                }
                if let Some(model_override) = custom
                    .model_overrides
                    .get(&model.provider)
                    .and_then(|overrides| overrides.get(&model.id))
                {
                    model = apply_model_override(&model, model_override);
                }
                model
            })
            .collect()
    }

    /// Custom models win on provider+id conflicts.
    fn merge_custom_models(&self, mut built_in: Vec<Model>, custom: Vec<Model>) -> Vec<Model> {
        for custom_model in custom {
            match built_in.iter().position(|model| {
                model.provider == custom_model.provider && model.id == custom_model.id
            }) {
                Some(index) => built_in[index] = custom_model,
                None => built_in.push(custom_model),
            }
        }
        built_in
    }

    /// Reload local state and refresh entitlements (live catalog + private
    /// auth). The chain refresh (the gated provider-catalog fetch + the
    /// credentialed Prime Inference fetch, TS `refreshProviderCatalog(false)`
    /// plus `refreshPrimeInferenceModels`) is awaited so the resolved
    /// catalog reflects it as soon as the call returns.
    pub async fn refresh_available_models(&mut self) -> Vec<Model> {
        let previous_ids = self.authorized_private_ids.clone();
        let previous_team = self.authorized_team_id.clone();
        let previous_models = self.authorized_private_models.clone();
        self.refresh();
        let credentials = self.prime_credentials();
        self.catalog
            .refresh_with_credentials(false, credentials.as_ref())
            .await;
        self.load_models();
        self.refresh_private_prime_inference_authorization(
            previous_ids,
            previous_team,
            previous_models,
        )
        .await;
        self.get_available().into_iter().cloned().collect()
    }

    #[allow(clippy::too_many_lines)]
    async fn refresh_private_prime_inference_authorization(
        &mut self,
        previous_ids: HashSet<String>,
        previous_team: Option<String>,
        previous_models: Vec<Model>,
    ) {
        let api_key = self.auth.get_api_key(PRIME_INFERENCE_PROVIDER_ID);
        let team_headers = self.auth.get_provider_headers(PRIME_INFERENCE_PROVIDER_ID);
        let team_id = team_headers
            .as_ref()
            .and_then(|headers| headers.get("X-Prime-Team-ID").cloned());
        let Some(api_key) = api_key else {
            return self.clear_private_authorization();
        };
        let (Some(team_headers), Some(team_id)) = (team_headers, team_id) else {
            return self.clear_private_authorization();
        };

        let fingerprint = private_prime_authorization_fingerprint(&api_key, &team_id);
        if let Some(cache_path) = self.models_json_path.clone() {
            let cached = read_private_prime_authorization_cache(&cache_path);
            if let Some(PrivatePrimeAuthorizationCache {
                fingerprint: cached_fingerprint,
                models,
                refreshed_at,
            }) = cached
            {
                if cached_fingerprint == fingerprint {
                    self.authorized_private_models.clone_from(&models);
                    self.authorized_private_ids =
                        models.iter().map(|model| model.id.clone()).collect();
                    self.authorized_team_id = Some(team_id.clone());
                    self.load_models();
                    let fresh =
                        now_millis() - refreshed_at < PRIVATE_PRIME_AUTHORIZATION_CACHE_TTL_MS;
                    if is_offline_mode_enabled() || fresh {
                        return;
                    }
                    return self
                        .background_private_refresh(
                            api_key,
                            team_headers,
                            team_id,
                            fingerprint,
                            cache_path,
                        )
                        .await;
                }
            }
        }
        if is_offline_mode_enabled() {
            return self.clear_private_authorization();
        }

        let public_ids = self.public_prime_inference_ids();
        let fetched = fetch_authorized_private_prime_inference_models(
            self.catalog.prime_inference_base_url(),
            &api_key,
            &team_headers,
            &public_ids,
            PRIVATE_MODEL_TIMEOUT_MS,
        )
        .await;
        match fetched {
            Ok(models) => {
                self.authorized_private_ids = models.iter().map(|model| model.id.clone()).collect();
                self.authorized_private_models.clone_from(&models);
                self.authorized_team_id = Some(team_id);
                self.load_models();
                if let Some(cache_path) = self.models_json_path.clone() {
                    write_private_prime_authorization_cache(
                        &cache_path,
                        &PrivatePrimeAuthorizationCache {
                            fingerprint,
                            models,
                            refreshed_at: now_millis(),
                        },
                    );
                }
            }
            Err(_) => {
                // Fetch failed: keep previous state for the same team.
                self.authorized_private_ids = previous_ids;
                self.authorized_private_models = previous_models;
                self.authorized_team_id = previous_team;
                self.load_models();
            }
        }
    }

    async fn background_private_refresh(
        &mut self,
        api_key: String,
        team_headers: HashMap<String, String>,
        team_id: String,
        fingerprint: String,
        cache_path: PathBuf,
    ) {
        let public_ids = self.public_prime_inference_ids();
        let Ok(models) = fetch_authorized_private_prime_inference_models(
            self.catalog.prime_inference_base_url(),
            &api_key,
            &team_headers,
            &public_ids,
            PRIVATE_BACKGROUND_TIMEOUT_MS,
        )
        .await
        else {
            return;
        };
        // Apply only if the credentials did not change while fetching.
        if private_prime_authorization_fingerprint(&api_key, &team_id) != fingerprint {
            return;
        }
        self.authorized_private_ids = models.iter().map(|model| model.id.clone()).collect();
        self.authorized_private_models.clone_from(&models);
        self.authorized_team_id = Some(team_id);
        self.load_models();
        write_private_prime_authorization_cache(
            &cache_path,
            &PrivatePrimeAuthorizationCache {
                fingerprint,
                models,
                refreshed_at: now_millis(),
            },
        );
    }

    /// The public Prime Inference ids the resolved catalog serves (the
    /// live-or-offline snapshot, TS `livePrimeInferenceModels ??
    /// bundledPrimeInferenceModels`): the private-authorization fetch
    /// skips these and reports only the account's private entitlements.
    fn public_prime_inference_ids(&self) -> HashSet<String> {
        self.models
            .iter()
            .filter(|model| {
                model.provider == PRIME_INFERENCE_PROVIDER_ID
                    && !is_private_prime_inference_model(model)
            })
            .map(|model| model.id.clone())
            .collect()
    }

    fn clear_private_authorization(&mut self) {
        self.authorized_private_ids.clear();
        self.authorized_private_models.clear();
        self.authorized_team_id = None;
        self.load_models();
    }

    fn is_authorized_private_model(&self, model: &Model) -> bool {
        self.explicit_private_ids.contains(&model.id)
            || self.authorized_private_ids.contains(&model.id)
    }

    /// `assumeAuthConfigured` validates an explicit stale-provider selection.
    pub async fn can_use_model(&mut self, model: &Model, assume_auth_configured: bool) -> bool {
        if assume_auth_configured {
            return !is_private_prime_inference_model(model)
                || self.is_authorized_private_model(model);
        }
        if !self.has_configured_auth(model) {
            return false;
        }
        if !is_private_prime_inference_model(model) {
            return true;
        }
        let available = self.refresh_available_models().await;
        available
            .iter()
            .any(|candidate| candidate.provider == model.provider && candidate.id == model.id)
    }

    /// Resolve request auth: API key + merged headers for a model.
    pub fn get_api_key_and_headers(
        &mut self,
        model: &Model,
        request_headers: Option<&BTreeMap<String, String>>,
    ) -> ResolvedRequestAuth {
        let stored = self
            .auth
            .get_api_key_with_source_token(&model.provider, false);
        let mut api_key = stored.api_key;
        let provider_config = self.provider_request_configs.get(&model.provider).cloned();
        if api_key.is_none() {
            if let Some(config) = &provider_config {
                if let Some(configured) = &config.api_key {
                    if let Some(resolved) =
                        crate::auth::resolve_config_value::resolve_config_value(configured)
                    {
                        api_key = Some(resolved);
                    }
                }
            }
        }
        let provider_headers = provider_config
            .as_ref()
            .and_then(|config| config.headers.clone());
        let auth_storage_headers = self.auth.get_provider_headers(&model.provider);
        let model_request_key = format!("{}:{}", model.provider, model.id);
        let model_request_headers = self.model_request_headers.get(&model_request_key).cloned();

        let mut headers: BTreeMap<String, String> = BTreeMap::new();
        if let Some(model_headers) = &model.headers {
            headers.extend(model_headers.clone());
        }
        if let Some(auth_storage_headers) = auth_storage_headers {
            headers.extend(auth_storage_headers);
        }
        if let Some(provider_headers) = provider_headers {
            headers.extend(provider_headers);
        }
        if let Some(model_request_headers) = model_request_headers {
            headers.extend(model_request_headers);
        }
        if provider_config
            .as_ref()
            .and_then(|config| config.auth_header)
            .unwrap_or(false)
        {
            let Some(api_key) = &api_key else {
                return ResolvedRequestAuth {
                    ok: false,
                    error: Some(format!("No API key found for \"{}\"", model.provider)),
                    ..Default::default()
                };
            };
            headers.insert("Authorization".to_string(), format!("Bearer {api_key}"));
        }
        if let Some(request_headers) = request_headers {
            headers.extend(request_headers.clone());
        }
        ResolvedRequestAuth {
            ok: true,
            api_key,
            headers: (!headers.is_empty()).then_some(headers),
            error: None,
        }
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::manager::{AuthStorage, NoOAuth};
    use crate::auth::types::AuthStorageData;
    use std::sync::Arc;

    fn auth_with(data: serde_json::Value) -> AuthStorage {
        let data = AuthStorageData(data.as_object().cloned().unwrap_or_default());
        AuthStorage::in_memory(data, Arc::new(NoOAuth))
    }

    /// Like [`auth_with`] but with ambient `PRIME_API_KEY`/`PRIME_TEAM_ID`
    /// ignored: the stored credential is the only source, so credential
    /// tests are hermetic on boxes that carry Prime Inference env vars.
    fn auth_without_env(data: serde_json::Value) -> AuthStorage {
        let data = AuthStorageData(data.as_object().cloned().unwrap_or_default());
        AuthStorage::in_memory_without_env(data, Arc::new(NoOAuth))
    }

    fn model(id: &str, provider: &str) -> Model {
        serde_json::from_value(serde_json::json!({
            "id": id, "name": id, "api": "openai-completions", "provider": provider,
            "baseUrl": "https://example.com", "reasoning": false, "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 1000, "maxTokens": 100
        }))
        .unwrap()
    }

    #[test]
    fn in_memory_loads_built_in_catalog() {
        let registry = ModelRegistry::in_memory(auth_with(serde_json::json!({})));
        assert!(registry.get_error().is_none());
        assert!(!registry.get_all().is_empty());
        // Bundled private model is present in the unfiltered catalog.
        assert!(registry
            .get_all()
            .iter()
            .any(|m| m.id == "internal/glm-5.2-fast"));
    }

    #[test]
    fn available_filters_by_configured_auth() {
        let auth = auth_with(serde_json::json!({
            "anthropic": { "type": "api_key", "key": "sk-ant" }
        }));
        let registry = ModelRegistry::in_memory(auth);
        // Stored credential authorizes the provider.
        assert!(registry.has_configured_auth(&model("m", "anthropic")));
        // An unconfigured provider (no stored cred, no env var, no models.json
        // key) is auth-gated out. The name is deliberately obscure so ambient
        // environment variables cannot authorize it.
        assert!(!registry.has_configured_auth(&model("m", "zz-no-provider")));
        // Available is a subset of all.
        let all = registry.get_all();
        let available = registry.get_available();
        assert!(available.iter().all(|available_model| {
            all.iter().any(|model| {
                model.id == available_model.id && model.provider == available_model.provider
            })
        }));
    }

    #[test]
    fn models_json_custom_models_and_auth_header() {
        let dir = tempfile::tempdir().unwrap();
        let models_path = dir.path().join("models.json");
        std::fs::write(
            &models_path,
            r#"{ "providers": { "custom": {
                "baseUrl": "https://custom.example", "apiKey": "custom-key",
                "api": "openai-completions", "authHeader": true,
                "models": [ { "id": "my-model" } ]
            } } }"#,
        )
        .unwrap();
        let auth = auth_with(serde_json::json!({}));
        let mut registry = ModelRegistry::create(auth, &models_path);
        assert!(registry.get_error().is_none());
        let custom = registry
            .get_all()
            .iter()
            .find(|m| m.provider == "custom" && m.id == "my-model")
            .expect("custom model merged")
            .clone();
        assert_eq!(custom.base_url, "https://custom.example");
        // models.json apiKey makes the provider available.
        assert!(registry.get_available().iter().any(|m| m.id == "my-model"));
        let auth_result = registry.get_api_key_and_headers(&custom, None);
        assert!(auth_result.ok);
        assert_eq!(auth_result.api_key.as_deref(), Some("custom-key"));
        assert_eq!(
            auth_result.headers.as_ref().unwrap().get("Authorization"),
            Some(&"Bearer custom-key".to_string())
        );
    }

    #[test]
    fn models_json_error_keeps_built_ins() {
        let dir = tempfile::tempdir().unwrap();
        let models_path = dir.path().join("models.json");
        std::fs::write(&models_path, "{ not json").unwrap();
        let registry = ModelRegistry::create(auth_with(serde_json::json!({})), &models_path);
        assert!(registry.get_error().is_some());
        assert!(!registry.get_all().is_empty());
    }

    #[test]
    fn header_precedence_model_over_provider() {
        let mut registry = ModelRegistry::in_memory(auth_with(serde_json::json!({
            "anthropic": { "type": "api_key", "key": "sk-ant" }
        })));
        let mut m = model("m", "anthropic");
        m.headers = Some(BTreeMap::from([(
            "X-Model".to_string(),
            "model".to_string(),
        )]));
        let result = registry.get_api_key_and_headers(&m, None);
        assert_eq!(result.api_key.as_deref(), Some("sk-ant"));
        assert_eq!(
            result.headers.as_ref().unwrap().get("X-Model").unwrap(),
            "model"
        );
        // Request headers win over everything.
        let request = BTreeMap::from([("X-Model".to_string(), "request".to_string())]);
        let result = registry.get_api_key_and_headers(&m, Some(&request));
        assert_eq!(
            result.headers.as_ref().unwrap().get("X-Model").unwrap(),
            "request"
        );
    }

    #[test]
    fn live_scope_keyed_cache_merges_over_the_compiled_prime_inference_models() {
        let dir = tempfile::tempdir().unwrap();
        let models_path = dir.path().join("models.json");
        std::fs::write(
            &models_path,
            r#"{ "providers": { "custom": {
                "baseUrl": "https://custom.example", "apiKey": "custom-key",
                "api": "openai-completions", "authHeader": true,
                "models": [ { "id": "my-model" } ]
            } } }"#,
        )
        .unwrap();
        // A live-catalog snapshot scoped to these credentials: one compiled
        // model repriced, one new entry, well past the coverage floor so
        // the build accepts it. The scope-keyed cache serves this scope's
        // snapshot only; another credential never sees it.
        let auth = auth_without_env(serde_json::json!({
            "prime-inference": { "type": "api_key", "key": "live-key",
                "primeTeam": { "teamId": "team-1", "name": "Team 1" } }
        }));
        let compiled = pa_models::transports::prime_inference_offline_entries();
        let repriced = &compiled[0];
        let mut entries = Vec::new();
        for model in &compiled {
            entries.push(serde_json::json!({
                "id": model.id,
                "display_name": model.name,
                "pricing": {
                    "input_usd_per_mtok": if model.id == repriced.id { 7.0 } else { model.cost.input.as_f64() },
                    "output_usd_per_mtok": model.cost.output.as_f64(),
                },
                "specs": {
                    "context_window": model.context_window,
                    "max_output_tokens": model.max_tokens,
                    "supports_reasoning": model.reasoning,
                    "modalities": { "input": ["text"], "output": ["text"] },
                },
            }));
        }
        entries.push(serde_json::json!({
            "id": "anthropic/live-only-model",
            "display_name": "Live Only Model",
            "pricing": { "input_usd_per_mtok": 1.0, "output_usd_per_mtok": 2.0 },
            "specs": {
                "context_window": 64000, "max_output_tokens": 8192,
                "supports_reasoning": false,
                "modalities": { "input": ["text"], "output": ["text"] },
            },
        }));
        let scope = pa_models::prime_inference::scope_key("live-key", "team-1");
        let snapshot = serde_json::json!({
            "url": format!("{}/models", super::super::prime_inference::PRIME_INFERENCE_BASE_URL),
            "scope": scope,
            "fetchedAt": 1,
            "payload": { "data": entries },
        });
        std::fs::create_dir_all(dir.path().join("models")).unwrap();
        std::fs::write(
            dir.path().join("models/prime-inference-models-cache.json"),
            serde_json::to_vec(&snapshot).unwrap(),
        )
        .unwrap();
        let mut registry = ModelRegistry::create(auth, &models_path);
        let all = registry.get_all().to_vec();
        // The live repriced model replaced its compiled template (other
        // providers may serve the same id; match the provider too).
        let repriced_model = all
            .iter()
            .find(|model| model.id == repriced.id && model.provider == "prime-inference")
            .expect("repriced model");
        assert_eq!(repriced_model.cost.input.as_f64(), 7.0);
        assert_eq!(
            repriced_model.base_url,
            super::super::prime_inference::PRIME_INFERENCE_BASE_URL
        );
        // The live-only model is present.
        assert!(all
            .iter()
            .any(|model| model.id == "anthropic/live-only-model"));
        // The custom models.json model survives the merge.
        assert!(all.iter().any(|model| model.id == "my-model"));
        // Compiled models of other providers stay.
        assert!(all
            .iter()
            .any(|model| model.provider == "anthropic" && model.id != repriced.id));
        // A different credential's scope never sees this snapshot.
        let other_auth = auth_without_env(serde_json::json!({
            "prime-inference": { "type": "api_key", "key": "other-key",
                "primeTeam": { "teamId": "team-2", "name": "Team 2" } }
        }));
        registry.auth = other_auth;
        registry.refresh();
        let all = registry.get_all().to_vec();
        let compiled_price = compiled
            .iter()
            .find(|model| model.id == repriced.id)
            .unwrap();
        let still_compiled = all
            .iter()
            .find(|model| model.id == repriced.id && model.provider == "prime-inference")
            .expect("compiled fallback for the other scope");
        assert_eq!(
            still_compiled.cost.input.as_f64(),
            compiled_price.cost.input.as_f64()
        );
        assert!(!all
            .iter()
            .any(|model| model.id == "anthropic/live-only-model"));
    }

    #[test]
    fn a_missing_or_corrupt_cache_falls_back_to_the_bundled_catalog() {
        let dir = tempfile::tempdir().unwrap();
        let models_path = dir.path().join("models.json");
        std::fs::write(&models_path, "{ not json").unwrap();
        std::fs::write(
            dir.path().join("prime-inference-models-cache.json"),
            "{ not json",
        )
        .unwrap();
        let registry = ModelRegistry::create(auth_with(serde_json::json!({})), &models_path);
        // The bundled public prime-inference models serve the catalog.
        assert!(registry
            .get_all()
            .iter()
            .any(|model| model.provider == "prime-inference"));
        assert!(registry.get_error().is_some());
    }

    #[test]
    fn explicit_private_ids_are_authorized() {
        let registry = ModelRegistry::in_memory(auth_with(serde_json::json!({})));
        let private_model = model("internal/custom-private", "prime-inference");
        assert!(!registry.is_authorized_private_model(&private_model));
    }
}
