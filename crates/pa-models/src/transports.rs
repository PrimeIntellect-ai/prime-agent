//! The compiled transport table.
//!
//! The compiled model catalog (`pa_ai::models_generated`, ported from the TS
//! `models.generated.ts`) is the hand-maintained table of transports the
//! client implements: 42 `(provider, api, baseUrl)` tuples across 31 public
//! providers, plus the 110 offline Prime Inference entries (live-fetch
//! domain, one transport tuple of its own). It only changes with a client
//! release — the catalog can select among these transports but never
//! introduce one.

use std::collections::HashSet;
use std::sync::LazyLock;

use crate::Model;

/// The compiled catalog, shared as one immutable list (the TS
/// `installedModels`).
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
