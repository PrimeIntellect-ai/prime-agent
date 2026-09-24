//! Model subsystem: resolver and Prime Inference private models.

pub use allowlist::{model_allowed, ModelAllowlistRefusal};
pub use private_auth::{
    get_private_prime_inference_models, private_prime_authorization_fingerprint,
    read_private_prime_authorization_cache, write_private_prime_authorization_cache,
    PrivatePrimeAuthorizationCache, PRIVATE_PRIME_AUTHORIZATION_CACHE_TTL_MS,
};
pub use registry::{ModelRegistry, ProviderRequestConfig, ResolvedRequestAuth};

pub use catalog_chain::{
    catalog_for, install_catalog, prime_credentials_for_dir, spawn_hourly_refresh, startup_refresh,
};

pub mod allowlist;
pub(crate) mod catalog_chain;
pub(crate) mod custom;
pub mod image_model_routing;
pub(crate) mod prime_inference;
pub(crate) mod prime_inference_catalog;
pub(crate) mod private_auth;
pub(crate) mod registry;
pub(crate) mod resolver;
pub(crate) mod session_restore;

pub use custom::{
    apply_model_override, load_custom_models, merge_compat, parse_models_config,
    strip_json_comments, validate_config, CustomModelsResult, ModelOverride, ModelsConfig,
    ProviderOverride,
};
pub use image_model_routing::{
    format_image_model_required_message, format_image_model_unusable_message,
    resolve_image_model_override, ImageModelRoutingInputs, ResolvedImageModel,
};
pub use prime_inference::{
    is_private_prime_inference_model, is_private_prime_inference_model_id,
    private_prime_inference_models, PRIME_INFERENCE_BASE_URL,
};
pub use prime_inference_catalog::{
    build_prime_inference_models, parse_prime_inference_model_catalog, PrimeInferenceCatalogEntry,
};
pub use resolver::{
    build_fallback_model, failover_candidates, find_exact_model_reference_match,
    find_initial_model, find_preferred_default_model, resolve_cli_model,
    resolve_model_scope_from_models, InitialModelOptions, ResolveCliModelResult, ScopedModel,
    PRIME_INFERENCE_DEFAULT_MODEL_ID,
};
pub use session_restore::{
    find_session_model_with_readiness_wait, SESSION_MODEL_RESTORE_READINESS_TIMEOUT_MS,
};
