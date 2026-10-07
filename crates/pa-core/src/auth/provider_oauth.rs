//! The built-in subscription providers' OAuth integration: the stored `openai-codex`, `anthropic`,
//! `github-copilot`, and `xai` credentials refresh at their token endpoints when they expire and
//! force-refresh when the server rejects a locally-valid token; every other provider serves its
//! access token until expiry.

use std::sync::Arc;

use pa_ai::oauth::{
    refresh_anthropic_token, refresh_github_copilot_token, refresh_openai_codex_token,
    refresh_xai_token, CodexHttp, ProviderHttp, ReqwestCodexHttp, ReqwestProviderHttp,
};
use pa_ai::utils::log::get_logger;

use crate::auth::types::{AuthCredential, AuthStorageData};

/// The Codex Subscription provider id (a wire identifier; branding
/// never renames a provider id).
pub const OPENAI_CODEX_PROVIDER_ID: &str = "openai-codex";
/// The Anthropic (Claude Pro/Max) subscription provider id.
pub const ANTHROPIC_PROVIDER_ID: &str = "anthropic";
pub const GITHUB_COPILOT_PROVIDER_ID: &str = "github-copilot";
/// The xAI (Grok) subscription provider id.
pub const XAI_PROVIDER_ID: &str = "xai";

/// The AI library's oauth registry as the auth storage's default
/// integration.
pub struct ProviderOAuth {
    http: Arc<dyn CodexHttp>,
    provider_http: Arc<dyn ProviderHttp>,
}

impl Default for ProviderOAuth {
    fn default() -> Self {
        Self::new()
    }
}

impl ProviderOAuth {
    #[must_use]
    pub fn new() -> Self {
        ProviderOAuth {
            http: Arc::new(ReqwestCodexHttp::new()),
            provider_http: Arc::new(ReqwestProviderHttp::new()),
        }
    }

    /// Fixed transports (tests and embedded hosts).
    pub fn with_transports(http: Arc<dyn CodexHttp>, provider_http: Arc<dyn ProviderHttp>) -> Self {
        ProviderOAuth {
            http,
            provider_http,
        }
    }

    /// A fixed Codex transport plus the production provider transport.
    pub fn with_http(http: Arc<dyn CodexHttp>) -> Self {
        ProviderOAuth {
            http,
            provider_http: Arc::new(ReqwestProviderHttp::new()),
        }
    }

    /// Refresh one credential off the async runtime (the `AuthStorage`
    /// seam is synchronous by contract): the exchange failure carries the
    /// provider's reason out, so the forced path can surface it and the
    /// expiry path can log it instead of dropping it silently.
    fn exchange_refresh(
        &self,
        provider_id: &str,
        credential: &AuthCredential,
    ) -> Result<AuthCredential, String> {
        let AuthCredential::Oauth {
            refresh: Some(refresh_token),
            enterprise_url,
            ..
        } = credential
        else {
            return Err("the credential carries no refresh token".to_string());
        };
        let http = Arc::clone(&self.http);
        let provider_http = Arc::clone(&self.provider_http);
        let refresh_token = refresh_token.clone();
        let enterprise_url = enterprise_url.clone();
        let provider_id = provider_id.to_string();
        std::thread::Builder::new()
            .name("provider-oauth-refresh".to_string())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|error| error.to_string())?;
                match provider_id.as_str() {
                    OPENAI_CODEX_PROVIDER_ID => runtime
                        .block_on(refresh_openai_codex_token(http.as_ref(), &refresh_token))
                        .map(|credentials| AuthCredential::Oauth {
                            access: credentials.access,
                            refresh: Some(credentials.refresh),
                            expires: credentials.expires,
                            account_id: Some(credentials.account_id),
                            enterprise_url: None,
                            endpoint: None,
                            token_endpoint: None,
                            client_id: None,
                            resource: None,
                            issuer: None,
                        }),
                    ANTHROPIC_PROVIDER_ID => runtime
                        .block_on(refresh_anthropic_token(
                            provider_http.as_ref(),
                            &refresh_token,
                        ))
                        .map(|credentials| AuthCredential::Oauth {
                            access: credentials.access,
                            refresh: Some(credentials.refresh),
                            expires: credentials.expires,
                            account_id: None,
                            enterprise_url: None,
                            endpoint: None,
                            token_endpoint: None,
                            client_id: None,
                            resource: None,
                            issuer: None,
                        }),
                    GITHUB_COPILOT_PROVIDER_ID => {
                        // The stored GitHub token exchanges for a fresh Copilot token; the
                        // enterprise domain rides the credential.
                        runtime
                            .block_on(refresh_github_copilot_token(
                                provider_http.as_ref(),
                                &refresh_token,
                                enterprise_url.as_deref(),
                            ))
                            .map(|credentials| AuthCredential::Oauth {
                                access: credentials.access,
                                refresh: Some(credentials.refresh),
                                expires: credentials.expires,
                                account_id: None,
                                enterprise_url: credentials.enterprise_url,
                                endpoint: None,
                                token_endpoint: None,
                                client_id: None,
                                resource: None,
                                issuer: None,
                            })
                    }
                    XAI_PROVIDER_ID => runtime
                        .block_on(refresh_xai_token(provider_http.as_ref(), &refresh_token))
                        .map(|credentials| AuthCredential::Oauth {
                            access: credentials.access,
                            refresh: Some(credentials.refresh),
                            expires: credentials.expires,
                            account_id: None,
                            enterprise_url: None,
                            endpoint: None,
                            token_endpoint: None,
                            client_id: None,
                            resource: None,
                            issuer: None,
                        }),
                    // The match arms cover the four subscription ids;
                    // a refresh never dispatches another.
                    _ => Err("unknown subscription provider".to_string()),
                }
            })
            .map_err(|error| format!("the refresh thread could not be spawned: {error}"))?
            .join()
            .map_err(|_| "the refresh thread panicked".to_string())?
    }
}
impl crate::auth::OAuthIntegration for ProviderOAuth {
    fn api_key_for(&self, _provider: &str, credential: &AuthCredential) -> Option<String> {
        match credential {
            AuthCredential::Oauth { access, .. } => Some(access.clone()),
            AuthCredential::ApiKey { .. } | AuthCredential::McpStaticToken { .. } => None,
        }
    }

    fn refresh(&self, provider_id: &str, credentials: &AuthStorageData) -> Option<AuthCredential> {
        if !matches!(
            provider_id,
            OPENAI_CODEX_PROVIDER_ID
                | ANTHROPIC_PROVIDER_ID
                | GITHUB_COPILOT_PROVIDER_ID
                | XAI_PROVIDER_ID
        ) {
            return None;
        }
        let Some(credential) = credentials.credential(provider_id) else {
            return None;
        };
        // The expiry-gated path keeps a failed credential for a later
        // retry; the failure is logged, never surfaced.
        let outcome = self.exchange_refresh(provider_id, &credential);
        if let Err(error) = &outcome {
            log_oauth_refresh_failure("core.auth", provider_id, error);
        }
        outcome.ok()
    }

    fn refresh_forced(
        &self,
        provider_id: &str,
        credentials: &AuthStorageData,
    ) -> Option<Result<AuthCredential, String>> {
        if !matches!(
            provider_id,
            OPENAI_CODEX_PROVIDER_ID
                | ANTHROPIC_PROVIDER_ID
                | GITHUB_COPILOT_PROVIDER_ID
                | XAI_PROVIDER_ID
        ) {
            return None;
        }
        let credential = credentials.credential(provider_id)?;
        if !matches!(
            &credential,
            AuthCredential::Oauth {
                refresh: Some(refresh_token),
                ..
            } if !refresh_token.is_empty()
        ) {
            return None;
        }
        let outcome = self.exchange_refresh(provider_id, &credential);
        if let Err(error) = &outcome {
            log_oauth_refresh_failure("core.auth", provider_id, error);
        } else {
            get_logger("core.auth").info(
                "oauth token refresh forced after a rejected access token",
                serde_json::json!({ "provider": provider_id }),
            );
        }
        Some(outcome)
    }
}

/// One structured warn line for a failed token exchange: the silent-failure
/// class of the revoked-session outage (refresh failures kept no trace).
fn log_oauth_refresh_failure(component: &str, provider_id: &str, error: &str) {
    get_logger(component).warn(
        "oauth token refresh failed",
        serde_json::json!({ "provider": provider_id, "error": error }),
    );
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use pa_ai::oauth::{CodexHttpResponse, ProviderHttpRequest, ProviderHttpResponse};

    use super::*;

    /// A scripted Codex transport (url -> response); unknown urls fail
    /// the request.
    struct ScriptedHttp(HashMap<String, CodexHttpResponse>);

    impl CodexHttp for ScriptedHttp {
        fn post_form<'a>(
            &'a self,
            url: &'a str,
            _body: &'a str,
            _timeout_ms: u64,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<CodexHttpResponse, String>> + Send + 'a>,
        > {
            let response = self.0.get(url).cloned();
            Box::pin(async move { response.ok_or_else(|| format!("{url} was not scripted")) })
        }
    }

    /// A scripted provider transport (url -> response); unknown urls
    /// fail the request.
    struct ScriptedProviderHttp(HashMap<String, ProviderHttpResponse>);

    impl ProviderHttp for ScriptedProviderHttp {
        fn request(
            &self,
            request: ProviderHttpRequest,
            _timeout_ms: u64,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<ProviderHttpResponse, String>> + Send + '_>,
        > {
            let response = self.0.get(&request.url).cloned();
            Box::pin(
                async move { response.ok_or_else(|| format!("{} was not scripted", request.url)) },
            )
        }
    }

    /// One fake access token carrying the account id (no signature
    /// verified, like the TS decode).
    fn account_jwt(account_id: &str) -> String {
        use base64::Engine as _;
        let segment = |value: &serde_json::Value| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_string(value).unwrap().as_bytes())
        };
        format!(
            "{}.{}.not-a-signature",
            segment(&serde_json::json!({"alg": "RS256"})),
            segment(&serde_json::json!({
                "https://api.openai.com/auth": {"chatgpt_account_id": account_id}
            }))
        )
    }

    fn expired_codex_credential() -> AuthCredential {
        AuthCredential::Oauth {
            access: "stale-access".to_string(),
            refresh: Some("r-old".to_string()),
            expires: 1,
            account_id: Some("acct-1".to_string()),
            enterprise_url: None,
            endpoint: None,
            token_endpoint: None,
            client_id: None,
            resource: None,
            issuer: None,
        }
    }

    /// One expired subscription credential for a provider id.
    fn expired_credential(provider_id: &str) -> AuthCredential {
        match provider_id {
            GITHUB_COPILOT_PROVIDER_ID => AuthCredential::Oauth {
                access: "stale-copilot".to_string(),
                refresh: Some("gh-old".to_string()),
                expires: 1,
                account_id: None,
                enterprise_url: Some("company.ghe.com".to_string()),
                endpoint: None,
                token_endpoint: None,
                client_id: None,
                resource: None,
                issuer: None,
            },
            _ => AuthCredential::Oauth {
                access: "stale-access".to_string(),
                refresh: Some("r-old".to_string()),
                expires: 1,
                account_id: None,
                enterprise_url: None,
                endpoint: None,
                token_endpoint: None,
                client_id: None,
                resource: None,
                issuer: None,
            },
        }
    }

    /// The scripted endpoints for the four subscription refreshes.
    fn integrations() -> std::sync::Arc<ProviderOAuth> {
        let mut codex = HashMap::new();
        codex.insert(
            "https://auth.openai.com/oauth/token".to_string(),
            CodexHttpResponse {
                status: 200,
                body: serde_json::json!({
                    "access_token": account_jwt("acct-2"),
                    "refresh_token": "r-new",
                    "expires_in": 3600,
                })
                .to_string(),
            },
        );
        let mut providers = HashMap::new();
        providers.insert(
            "https://platform.claude.com/v1/oauth/token".to_string(),
            ProviderHttpResponse {
                status: 200,
                body: serde_json::json!({
                    "access_token": "anthropic-access",
                    "refresh_token": "anthropic-refresh",
                    "expires_in": 3600,
                })
                .to_string(),
            },
        );
        providers.insert(
            "https://api.company.ghe.com/copilot_internal/v2/token".to_string(),
            ProviderHttpResponse {
                status: 200,
                body: serde_json::json!({
                    "token": "copilot-access",
                    "expires_at": 4_000_000_000i64,
                })
                .to_string(),
            },
        );
        providers.insert(
            "https://auth.x.ai/oauth2/token".to_string(),
            ProviderHttpResponse {
                status: 200,
                body: serde_json::json!({
                    "access_token": "grok-access",
                    "refresh_token": "grok-refresh",
                    "expires_in": 3600,
                })
                .to_string(),
            },
        );
        std::sync::Arc::new(ProviderOAuth::with_transports(
            std::sync::Arc::new(ScriptedHttp(codex)),
            std::sync::Arc::new(ScriptedProviderHttp(providers)),
        ))
    }

    fn storage_with_credential(
        provider_id: &str,
        credential: &AuthCredential,
    ) -> crate::auth::AuthStorage {
        let mut data = crate::auth::types::AuthStorageData::default();
        data.insert(provider_id, credential);
        crate::auth::AuthStorage::in_memory_without_env(&data, integrations())
    }

    #[test]
    fn an_expired_codex_credential_refreshes_and_resolves() {
        let mut auth =
            storage_with_credential(OPENAI_CODEX_PROVIDER_ID, &expired_codex_credential());
        let api_key = auth
            .get_api_key(OPENAI_CODEX_PROVIDER_ID)
            .expect("the refreshed access token resolves");
        assert_eq!(api_key, account_jwt("acct-2"));
        let stored = auth.get_all().credential(OPENAI_CODEX_PROVIDER_ID).unwrap();
        let AuthCredential::Oauth {
            access,
            refresh,
            expires,
            account_id,
            ..
        } = stored
        else {
            panic!("the stored credential is OAuth");
        };
        assert_eq!(access, account_jwt("acct-2"));
        assert_eq!(refresh.as_deref(), Some("r-new"));
        assert!(expires > 1, "the fresh expiry landed");
        assert_eq!(account_id.as_deref(), Some("acct-2"));
    }

    #[test]
    fn an_expired_anthropic_credential_refreshes_and_resolves() {
        let mut auth = storage_with_credential(
            ANTHROPIC_PROVIDER_ID,
            &expired_credential(ANTHROPIC_PROVIDER_ID),
        );
        let api_key = auth
            .get_api_key(ANTHROPIC_PROVIDER_ID)
            .expect("the refreshed access token resolves");
        assert_eq!(api_key, "anthropic-access");
        let stored = auth.get_all().credential(ANTHROPIC_PROVIDER_ID).unwrap();
        let AuthCredential::Oauth {
            refresh, expires, ..
        } = stored
        else {
            panic!("the stored credential is OAuth");
        };
        assert_eq!(refresh.as_deref(), Some("anthropic-refresh"));
        assert!(expires > 1, "the fresh expiry landed");
    }

    #[test]
    fn an_expired_copilot_credential_refreshes_through_the_enterprise_domain() {
        let mut auth = storage_with_credential(
            GITHUB_COPILOT_PROVIDER_ID,
            &expired_credential(GITHUB_COPILOT_PROVIDER_ID),
        );
        let api_key = auth
            .get_api_key(GITHUB_COPILOT_PROVIDER_ID)
            .expect("the refreshed Copilot token resolves");
        assert_eq!(api_key, "copilot-access");
        let stored = auth
            .get_all()
            .credential(GITHUB_COPILOT_PROVIDER_ID)
            .unwrap();
        let AuthCredential::Oauth {
            refresh,
            expires,
            enterprise_url,
            ..
        } = stored
        else {
            panic!("the stored credential is OAuth");
        };
        // The GitHub token stays the refresh source; the enterprise
        // domain rides the credential.
        assert_eq!(refresh.as_deref(), Some("gh-old"));
        assert_eq!(enterprise_url.as_deref(), Some("company.ghe.com"));
        assert!(expires > 1, "the fresh expiry landed");
    }

    #[test]
    fn an_expired_xai_credential_refreshes_and_resolves() {
        let mut auth =
            storage_with_credential(XAI_PROVIDER_ID, &expired_credential(XAI_PROVIDER_ID));
        let api_key = auth
            .get_api_key(XAI_PROVIDER_ID)
            .expect("the refreshed access token resolves");
        assert_eq!(api_key, "grok-access");
        let stored = auth.get_all().credential(XAI_PROVIDER_ID).unwrap();
        let AuthCredential::Oauth {
            refresh, expires, ..
        } = stored
        else {
            panic!("the stored credential is OAuth");
        };
        assert_eq!(refresh.as_deref(), Some("grok-refresh"));
        assert!(expires > 1, "the fresh expiry landed");
    }

    #[test]
    fn a_failed_refresh_keeps_the_stored_credential() {
        // Nothing scripted: the refresh fails, the stored credential stays.
        let mut auth = crate::auth::AuthStorage::in_memory_without_env(
            &{
                let mut data = crate::auth::types::AuthStorageData::default();
                data.insert(OPENAI_CODEX_PROVIDER_ID, &expired_codex_credential());
                data
            },
            std::sync::Arc::new(ProviderOAuth::with_transports(
                std::sync::Arc::new(ScriptedHttp(HashMap::new())),
                std::sync::Arc::new(ScriptedProviderHttp(HashMap::new())),
            )),
        );
        assert_eq!(auth.get_api_key(OPENAI_CODEX_PROVIDER_ID), None);
        assert!(
            auth.get_all()
                .credential(OPENAI_CODEX_PROVIDER_ID)
                .is_some(),
            "the failed refresh keeps the stored credential"
        );
    }

    #[test]
    fn a_locally_valid_credential_force_refreshes_and_resolves() {
        // The revoked-session shape: the expiry is still future-dated, so
        // only the forced refresh reaches the token endpoint.
        let mut live = expired_codex_credential();
        live.access = "rejected-access".to_string();
        live.expires = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(i64::MAX)
            + 3_600_000;
        let mut auth = storage_with_credential(OPENAI_CODEX_PROVIDER_ID, &live);
        assert_eq!(
            auth.get_api_key(OPENAI_CODEX_PROVIDER_ID).as_deref(),
            Some("rejected-access"),
            "the locally-valid credential still serves"
        );
        let refreshed = auth.force_refresh_oauth(OPENAI_CODEX_PROVIDER_ID);
        assert!(matches!(
            &refreshed,
            Ok(AuthCredential::Oauth { access, .. }) if access == &account_jwt("acct-2")
        ));
        assert_eq!(
            auth.get_api_key(OPENAI_CODEX_PROVIDER_ID).as_deref(),
            Some(account_jwt("acct-2").as_str()),
            "the refreshed credential resolves"
        );
    }

    #[test]
    fn a_rejected_force_refresh_carries_the_server_reason() {
        // Nothing scripted: the exchange fails, the reason carries out,
        // and the stored credential stands untouched.
        let mut live = expired_codex_credential();
        live.access = "rejected-access".to_string();
        live.expires = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(i64::MAX)
            + 3_600_000;
        let mut auth = crate::auth::AuthStorage::in_memory_without_env(
            &{
                let mut data = crate::auth::types::AuthStorageData::default();
                data.insert(OPENAI_CODEX_PROVIDER_ID, &live);
                data
            },
            std::sync::Arc::new(ProviderOAuth::with_transports(
                std::sync::Arc::new(ScriptedHttp(HashMap::new())),
                std::sync::Arc::new(ScriptedProviderHttp(HashMap::new())),
            )),
        );
        let outcome = auth.force_refresh_oauth(OPENAI_CODEX_PROVIDER_ID);
        let reason = outcome.expect_err("the failed exchange carries its reason");
        assert!(
            reason.contains("was not scripted"),
            "the server-side reason carries out for the re-login surface: {reason}"
        );
        let stored = auth
            .get_all()
            .credential(OPENAI_CODEX_PROVIDER_ID)
            .expect("the stored credential stands untouched");
        assert!(matches!(
            stored,
            AuthCredential::Oauth { ref access, .. } if access == "rejected-access"
        ));
    }

    #[test]
    fn a_credential_without_a_refresh_token_has_no_forced_refresh() {
        let mut without_refresh = expired_codex_credential();
        without_refresh.refresh = None;
        let mut auth = storage_with_credential(OPENAI_CODEX_PROVIDER_ID, &without_refresh);
        let outcome = auth.force_refresh_oauth(OPENAI_CODEX_PROVIDER_ID);
        assert_eq!(
            outcome.unwrap_err(),
            "the stored credential for openai-codex carries no refresh token"
        );
    }

    #[test]
    fn non_subscription_providers_do_not_refresh() {
        let mut auth = storage_with_credential("other-oauth", &expired_credential("other-oauth"));
        assert_eq!(auth.get_api_key("other-oauth"), None);
        assert!(auth.get_all().credential("other-oauth").is_some());
    }

    #[test]
    fn an_unexpired_credential_serves_without_a_refresh() {
        let unexpired = AuthCredential::Oauth {
            access: "live-access".to_string(),
            refresh: Some("r".to_string()),
            expires: i64::MAX,
            account_id: Some("acct-1".to_string()),
            enterprise_url: None,
            endpoint: None,
            token_endpoint: None,
            client_id: None,
            resource: None,
            issuer: None,
        };
        let mut auth = storage_with_credential(OPENAI_CODEX_PROVIDER_ID, &unexpired);
        assert_eq!(
            auth.get_api_key(OPENAI_CODEX_PROVIDER_ID),
            Some("live-access".to_string())
        );
    }
}
