//! Model subsystem: resolver and Prime Inference private models.

pub use allowlist::{model_allowed, ModelAllowlistRefusal};
pub use registry::{
    ModelRegistry, ProviderRequestConfig, ResolvedRequestAuth, SetModelSelectionError,
};

pub use catalog_chain::{
    catalog_for, install_catalog, prime_credentials_for_dir, spawn_hourly_refresh, startup_refresh,
};
/// The refresh triggers (`pa-models`' own enum — the daemon's picker-open
/// and auth-change wiring selects it; pa-daemon's runtime surface goes
/// through pa-core, so the trigger rides this re-export).
pub use pa_models::RefreshTrigger;

pub mod allowlist;
pub(crate) mod catalog_chain;
pub(crate) mod custom;
pub mod image_model_routing;
pub(crate) mod prime_inference;
pub(crate) mod registry;
pub(crate) mod resolver;
pub(crate) mod session_restore;

pub use custom::{
    apply_model_override, load_custom_models, merge_compat, parse_models_config,
    strip_json_comments, validate_config, CustomModelsResult, ModelOverride, ModelsConfig,
    ProviderOverride,
};
pub use image_model_routing::{
    resolve_image_model_override, ImageModelRoutingInputs, ResolvedImageModel,
};
pub use prime_inference::{
    is_private_prime_inference_model, is_private_prime_inference_model_id, PRIME_INFERENCE_BASE_URL,
};
pub use resolver::{
    build_fallback_model, failover_candidates, find_exact_model_reference_match,
    find_initial_model, find_preferred_default_model, resolve_cli_model,
    resolve_model_scope_from_models, scope_patterns_select_reference, InitialModelOptions,
    ResolveCliModelResult, ScopedModel, PRIME_INFERENCE_DEFAULT_MODEL_ID,
};
pub use session_restore::{
    find_session_model_with_readiness_wait, resolve_model_scope_from_models_with_readiness,
    SESSION_MODEL_RESTORE_READINESS_TIMEOUT_MS,
};
