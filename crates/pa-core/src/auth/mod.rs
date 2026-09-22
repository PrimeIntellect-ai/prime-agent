//! Auth subsystem: credential storage, resolution priority, stale-marking.

pub(crate) mod manager;
pub(crate) mod resolve_config_value;
pub(crate) mod storage;
pub(crate) mod types;

pub use manager::{AuthApiKeyResult, AuthStorage, NoOAuth, OAuthIntegration};
pub use storage::{
    parse_storage_data, AuthStorageBackend, FileAuthStorageBackend, InMemoryAuthStorageBackend,
};
pub use types::{
    AuthCredential, AuthSource, AuthSourceToken, AuthStatus, AuthStorageData, PrimeTeamCredential,
    PRIME_INFERENCE_PROVIDER_ID,
};
