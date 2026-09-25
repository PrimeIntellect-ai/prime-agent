//! Auth subsystem: credential storage, resolution priority, stale-marking.

pub(crate) mod manager;
pub(crate) mod prime_inference;
pub(crate) mod prime_inference_login;
pub(crate) mod prime_traces;
pub(crate) mod resolve_config_value;
pub(crate) mod storage;
pub(crate) mod types;

pub use manager::{AuthApiKeyResult, AuthStorage, NoOAuth, OAuthIntegration};
pub use prime_inference::{
    check_prime_inference_access, default_prime_cli_config_path, fetch_prime_teams,
    read_prime_cli_config, resolve_prime_inference_auth_config, PrimeAccessError,
    PrimeAccessFailure, PrimeCliConfig, PrimeHttp, PrimeHttpResponse, PrimeInferenceAuthConfig,
    ReqwestPrimeHttp, DEFAULT_PRIME_API_BASE_URL, DEFAULT_PRIME_FRONTEND_URL,
    DEFAULT_REQUEST_TIMEOUT_MS,
};
pub use prime_inference_login::{
    login_prime_inference, PrimeInferenceLoginCallbacks, PrimeInferenceLoginOptions,
    PrimeInferenceLoginResult, PrimeInferenceLoginSource,
};
pub use prime_traces::{
    check_prime_agent_traces_access, login_prime_agent_traces, resolve_prime_agent_traces_base_url,
    PrimeAgentTracesCallbacks, PrimeAgentTracesLoginOptions, PrimeAgentTracesLoginSource,
    PrimeAuthInfo, PRIME_AGENT_TRACES_PROVIDER_ID, PRIME_AGENT_TRACES_PROVIDER_NAME,
};
pub use storage::{
    parse_storage_data, AuthStorageBackend, FileAuthStorageBackend, InMemoryAuthStorageBackend,
};
pub use types::{
    AuthCredential, AuthSource, AuthSourceToken, AuthStatus, AuthStorageData, PrimeTeamAssignment,
    PrimeTeamCredential, StoredPrimeTeam, PRIME_INFERENCE_PROVIDER_ID,
};
