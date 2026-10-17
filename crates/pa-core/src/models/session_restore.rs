//! Session-model restore with a bounded catalog-readiness wait: a revived
//! session's saved model can be missing only because the boot's
//! catalog/auth refresh has not settled. Without the wait the restore
//! silently lands on the startup-chain default instead of the saved model.

use std::time::Duration;

use pa_types::ai::Model;

use super::registry::ModelRegistry;
use super::resolver::{
    is_private_prime_inference_reference, resolve_model_scope_from_models,
    scope_patterns_select_reference, ScopedModel,
};

/// The bounded window a session-model restore waits for in-flight catalog/auth refreshes to settle
/// before the lookup may fail.
pub const SESSION_MODEL_RESTORE_READINESS_TIMEOUT_MS: u64 = 5_000;

/// The model is registered and its provider has configured auth (TS `findRestorable`).
fn find_restorable(registry: &ModelRegistry, provider: &str, model_id: &str) -> Option<Model> {
    registry
        .get_all()
        .iter()
        .find(|model| model.provider == provider && model.id == model_id)
        .filter(|model| registry.has_configured_auth(model))
        .cloned()
}

/// Find a saved session model, giving in-flight catalog/auth refreshes a
/// bounded window to settle before the lookup may fail. A miss returns
/// `None`, leaving the caller to fall back (and to say so: the fallback
/// must never be silent).
pub async fn find_session_model_with_readiness_wait(
    registry: &mut ModelRegistry,
    provider: &str,
    model_id: &str,
    readiness_timeout_ms: u64,
) -> Option<Model> {
    let direct = find_restorable(registry, provider, model_id);
    if direct.is_some() {
        return direct;
    }
    let _ = tokio::time::timeout(
        Duration::from_millis(readiness_timeout_ms),
        registry.refresh_available_models(),
    )
    .await;
    find_restorable(registry, provider, model_id)
}

pub async fn resolve_model_scope_from_models_with_readiness(
    registry: &mut ModelRegistry,
    patterns: &[String],
    default: Option<(&str, &str)>,
    is_continuing: bool,
    readiness_timeout_ms: u64,
) -> Vec<ScopedModel> {
    let available: Vec<Model> = registry.get_available().into_iter().cloned().collect();
    let scoped = resolve_model_scope_from_models(patterns, &available);
    let default_missing = !is_continuing
        && default.is_some_and(|(provider, model_id)| {
            is_private_prime_inference_reference(provider, model_id)
                && !scoped
                    .iter()
                    .any(|scoped| scoped.model.provider == provider && scoped.model.id == model_id)
                && scope_patterns_select_reference(
                    patterns,
                    provider,
                    model_id,
                    &available,
                    registry.get_all(),
                )
        });
    if !default_missing {
        return scoped;
    }
    if tokio::time::timeout(
        Duration::from_millis(readiness_timeout_ms),
        registry.refresh_available_models(),
    )
    .await
    .is_err()
    {
        return scoped;
    }
    let available: Vec<Model> = registry.get_available().into_iter().cloned().collect();
    resolve_model_scope_from_models(patterns, &available)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn restore_requires_a_registered_model_with_configured_auth() {
        let auth = crate::auth::AuthStorage::in_memory_without_env(
            &crate::auth::AuthStorageData::default(),
            std::sync::Arc::new(crate::auth::NoOAuth),
        );
        let mut registry = ModelRegistry::in_memory(auth);
        assert!(
            find_session_model_with_readiness_wait(
                &mut registry,
                "prime-inference",
                "z-ai/glm-5.3",
                0
            )
            .await
            .is_none(),
            "no provider auth configured: not restorable"
        );
        assert!(
            find_session_model_with_readiness_wait(&mut registry, "anthropic", "missing", 0)
                .await
                .is_none(),
            "not registered: not restorable"
        );
    }
}
