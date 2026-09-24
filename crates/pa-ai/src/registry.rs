//! API provider registry.
//!
//! Ported from `packages/ai/src/api-registry.ts`: providers register stream
//! functions per `api` identifier; `stream()`/`complete()` resolve the
//! provider for a model and forward.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock};

use crate::event_stream::AssistantMessageEventStream;
use crate::types::{Context, Model, SimpleStreamOptions, StreamOptions};

/// A provider implementation for one API (the TS `ApiProvider`).
pub trait Provider: Send + Sync {
    /// The `api` identifier this provider serves, e.g. "openai-completions".
    fn api(&self) -> &str;

    fn stream(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&StreamOptions>,
    ) -> AssistantMessageEventStream;

    fn stream_simple(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&SimpleStreamOptions>,
    ) -> AssistantMessageEventStream;
}

struct RegisteredProvider {
    provider: Arc<dyn Provider>,
    source_id: Option<String>,
}

fn registry() -> &'static RwLock<HashMap<String, RegisteredProvider>> {
    static REGISTRY: OnceLock<RwLock<HashMap<String, RegisteredProvider>>> = OnceLock::new();
    REGISTRY.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Register (or replace) the provider for `provider.api()`.
pub fn register_api_provider(provider: Arc<dyn Provider>, source_id: Option<&str>) {
    let mut registry = registry().write().unwrap();
    registry.insert(
        provider.api().to_string(),
        RegisteredProvider {
            provider,
            source_id: source_id.map(std::string::ToString::to_string),
        },
    );
}

/// Look up the provider for an api identifier.
pub fn get_api_provider(api: &str) -> Option<Arc<dyn Provider>> {
    registry()
        .read()
        .unwrap()
        .get(api)
        .map(|entry| entry.provider.clone())
}

/// All registered providers.
pub fn get_api_providers() -> Vec<Arc<dyn Provider>> {
    registry()
        .read()
        .unwrap()
        .values()
        .map(|entry| entry.provider.clone())
        .collect()
}

/// Unregister providers installed with the given source id (extension teardown).
pub fn unregister_api_providers(source_id: &str) {
    let mut registry = registry().write().unwrap();
    registry.retain(|_, entry| entry.source_id.as_deref() != Some(source_id));
}

/// Remove all registered providers.
pub fn clear_api_providers() {
    registry().write().unwrap().clear();
}

/// Register the built-in providers (explicit Rust equivalent of the TS
/// side-effect import in `stream.ts` / `register-builtins.ts`).
pub fn register_builtin_api_providers() {
    let mut registry = registry().write().unwrap();
    // Providers are registered here as they are ported; each entry mirrors the
    // corresponding import in `providers/register-builtins.ts`.
    let builtins: Vec<Arc<dyn Provider>> = vec![
        Arc::new(crate::providers::anthropic::AnthropicMessagesProvider),
        Arc::new(crate::providers::openai_completions::OpenAICompletionsProvider),
        Arc::new(crate::providers::openai_responses::OpenAIResponsesProvider),
        Arc::new(crate::providers::azure_openai_responses::AzureOpenAIResponsesProvider),
        Arc::new(crate::providers::google::GoogleGenerativeAiProvider),
        Arc::new(crate::providers::google_vertex::GoogleVertexProvider),
        Arc::new(crate::providers::mistral::MistralConversationsProvider),
        Arc::new(crate::providers::bedrock::BedrockConverseStreamProvider),
        Arc::new(crate::providers::openai_codex_responses::OpenAICodexResponsesProvider),
    ];
    for provider in builtins {
        registry.insert(
            provider.api().to_string(),
            RegisteredProvider {
                provider,
                source_id: None,
            },
        );
    }
}

/// Clear then re-register built-ins (test helper parity with `resetApiProviders`).
pub fn reset_api_providers() {
    clear_api_providers();
    register_builtin_api_providers();
}

/// Ensure built-ins are present (idempotent; matches the TS import side effect).
pub fn ensure_builtins() {
    static ENSURED: OnceLock<()> = OnceLock::new();
    ENSURED.get_or_init(register_builtin_api_providers);
}

/// Registry facade over the process-wide provider map: the type consumers
/// hold and call (the free functions below remain for parity with the TS
/// module surface).
pub struct ProviderRegistry;

impl ProviderRegistry {
    /// Register (or replace) the provider for `provider.api()`.
    pub fn register(&self, provider: Arc<dyn Provider>, source_id: Option<&str>) {
        register_api_provider(provider, source_id);
    }

    /// Look up the provider for an api identifier.
    pub fn get(&self, api: &str) -> Option<Arc<dyn Provider>> {
        get_api_provider(api)
    }

    /// All registered providers.
    pub fn all(&self) -> Vec<Arc<dyn Provider>> {
        get_api_providers()
    }

    /// Unregister providers installed with the given source id.
    pub fn unregister(&self, source_id: &str) {
        unregister_api_providers(source_id);
    }

    /// Remove all registered providers.
    pub fn clear(&self) {
        clear_api_providers();
    }

    /// Clear then re-register built-ins.
    pub fn reset(&self) {
        reset_api_providers();
    }
}
