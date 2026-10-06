//! The compiled transport table.
//! `pa_ai::models_generated` is the hand-maintained table of transports
//! the client implements; it only changes with a client release — the
//! catalog can select among these but never introduce one.

use std::collections::HashSet;
use std::sync::LazyLock;

use crate::Model;

/// The compiled catalog, shared as one immutable list (TS `installedModels`).
#[must_use]
pub fn compiled_models() -> &'static [Model] {
    static COMPILED: LazyLock<Vec<Model>> = LazyLock::new(|| {
        let mut models: Vec<Model> = pa_ai::models_generated::get_providers()
            .into_iter()
            .flat_map(pa_ai::models_generated::get_models)
            .cloned()
            .collect();
        models.shrink_to_fit();
        models
    });
    &COMPILED
}

/// Distinct compiled `(provider, api, baseUrl)` tuples (Prime Inference
/// excluded — its transport is served by the live-fetch domain).
#[must_use]
pub fn compiled_transport_tuples() -> Vec<(&'static str, &'static str, &'static str)> {
    let mut tuples: Vec<(&'static str, &'static str, &'static str)> = Vec::new();
    let mut seen: HashSet<(&str, &str, &str)> = HashSet::new();
    for model in compiled_models() {
        if model.provider == "prime-inference" {
            continue;
        }
        if seen.insert((
            model.provider.as_str(),
            model.api.as_str(),
            model.base_url.as_str(),
        )) {
            tuples.push((
                model.provider.as_str(),
                model.api.as_str(),
                model.base_url.as_str(),
            ));
        }
    }
    tuples
}

/// The compiled offline Prime Inference entries (the onboarding fallback
/// before the first credentialed fetch). Private ids (internal/, dev/, ids
/// containing `:`) never ship compiled.
#[must_use]
pub fn prime_inference_offline_entries() -> Vec<Model> {
    compiled_models()
        .iter()
        .filter(|model| {
            model.provider == "prime-inference"
                && !crate::prime_inference::is_private_prime_inference_model_id(&model.id)
        })
        .cloned()
        .collect()
}
