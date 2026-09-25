//! The built-in subscription providers' OAuth integration (TS the auth
//! storage delegates to the AI library's oauth registry): the stored
//! `openai-codex` credential refreshes at the token endpoint when it
//! expires. Every other provider serves its access token until expiry —
//! this build has no refresh flow for them either (their `/login` rows
//! are marked unavailable), so refresh answers `None` and resolution
//! keeps the stored credential for a later explicit re-login.
//!
//! The [`OAuthIntegration`] seam is synchronous by contract (it runs
//! under the storage's file lock), so the refresh runs on its own
//! short-lived thread with a private runtime — the same bridge the MCP
//! integration uses. Refreshes are rare: token expiry, once per hour at
//! worst.

use std::sync::Arc;

use pa_ai::oauth::{refresh_openai_codex_token, CodexHttp, ReqwestCodexHttp};

use crate::auth::types::{AuthCredential, AuthStorageData};

/// The Codex Subscription provider id (the wire identifier the TS
/// product registers; branding never renames a provider id).
pub const OPENAI_CODEX_PROVIDER_ID: &str = "openai-codex";

/// The AI library's oauth registry as the auth storage's default
/// integration.
pub struct ProviderOAuth {
    http: Arc<dyn CodexHttp>,
}

impl Default for ProviderOAuth {
    fn default() -> Self {
        Self::new()
    }
}

impl ProviderOAuth {
    /// The production transport.
    pub fn new() -> Self {
        ProviderOAuth {
            http: Arc::new(ReqwestCodexHttp::new()),
        }
    }

    /// A fixed transport (tests and embedded hosts).
    pub fn with_http(http: Arc<dyn CodexHttp>) -> Self {
        ProviderOAuth { http }
    }

    /// Refresh one expired codex credential off the async runtime (the
    /// `AuthStorage` seam is synchronous by contract).
    fn refresh_blocking(&self, credential: &AuthCredential) -> Option<AuthCredential> {
        let AuthCredential::Oauth {
            refresh: Some(refresh_token),
            ..
        } = credential
        else {
            return None;
        };
        let http = Arc::clone(&self.http);
        let refresh_token = refresh_token.clone();
        std::thread::Builder::new()
            .name("provider-oauth-refresh".to_string())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .ok()?;
                let credentials = runtime
                    .block_on(refresh_openai_codex_token(http.as_ref(), &refresh_token))
                    .ok()?;
                Some(AuthCredential::Oauth {
                    access: credentials.access,
                    refresh: Some(credentials.refresh),
                    expires: credentials.expires,
                    account_id: Some(credentials.account_id),
                    endpoint: None,
                    token_endpoint: None,
                    client_id: None,
                    resource: None,
                    issuer: None,
                })
            })
            .ok()?
            .join()
            .ok()?
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
        if provider_id != OPENAI_CODEX_PROVIDER_ID {
            return None;
        }
        let credential = credentials.credential(provider_id)?;
        self.refresh_blocking(&credential)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use pa_ai::oauth::CodexHttpResponse;

    use super::*;

    /// A scripted transport (url -> response); unknown urls fail the
    /// request. The codex refresh token endpoint is the flow's constant,
    /// so the scripted map keys the one url.
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

    /// One fake access token carrying the account id (the flow never
    /// verifies a signature, like the TS decode).
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
            endpoint: None,
            token_endpoint: None,
            client_id: None,
            resource: None,
            issuer: None,
        }
    }

    fn storage_with_credential(credential: AuthCredential) -> crate::auth::AuthStorage {
        let mut data = crate::auth::types::AuthStorageData::default();
        data.insert(OPENAI_CODEX_PROVIDER_ID, &credential);
        data.insert("anthropic", &expired_codex_credential());
        crate::auth::AuthStorage::in_memory_without_env(
            data,
            std::sync::Arc::new(ProviderOAuth::with_http(Arc::new(ScriptedHttp(
                [(
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
                )]
                .into_iter()
                .collect(),
            )))),
        )
    }

    #[test]
    fn an_expired_codex_credential_refreshes_and_resolves() {
        let mut auth = storage_with_credential(expired_codex_credential());
        let api_key = auth
            .get_api_key(OPENAI_CODEX_PROVIDER_ID)
            .expect("the refreshed access token resolves");
        assert_eq!(api_key, account_jwt("acct-2"));
        // The refreshed credential persisted: the account id rode along
        // (TS stores the fresh login's `accountId`).
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
    fn a_failed_refresh_keeps_the_stored_credential() {
        // Nothing scripted: the refresh fails and resolution skips the
        // provider, keeping the stored credential for a later retry.
        let mut data = crate::auth::types::AuthStorageData::default();
        data.insert(OPENAI_CODEX_PROVIDER_ID, &expired_codex_credential());
        let mut auth = crate::auth::AuthStorage::in_memory_without_env(
            data,
            std::sync::Arc::new(ProviderOAuth::with_http(Arc::new(ScriptedHttp(
                HashMap::new(),
            )))),
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
    fn other_providers_do_not_refresh() {
        // The anthropic credential is expired too, but no refresh flow
        // exists for it: resolution stays absent and the credential stays.
        let mut auth = storage_with_credential(expired_codex_credential());
        assert_eq!(auth.get_api_key("anthropic"), None);
        assert!(auth.get_all().credential("anthropic").is_some());
    }

    #[test]
    fn an_unexpired_credential_serves_without_a_refresh() {
        // A credential in its validity window resolves its access token
        // directly; no token request fires.
        let mut data = crate::auth::types::AuthStorageData::default();
        let unexpired = AuthCredential::Oauth {
            access: "live-access".to_string(),
            refresh: Some("r".to_string()),
            expires: i64::MAX,
            account_id: Some("acct-1".to_string()),
            endpoint: None,
            token_endpoint: None,
            client_id: None,
            resource: None,
            issuer: None,
        };
        data.insert(OPENAI_CODEX_PROVIDER_ID, &unexpired);
        let mut auth = crate::auth::AuthStorage::in_memory_without_env(
            data,
            std::sync::Arc::new(ProviderOAuth::with_http(Arc::new(ScriptedHttp(
                HashMap::new(),
            )))),
        );
        assert_eq!(
            auth.get_api_key(OPENAI_CODEX_PROVIDER_ID),
            Some("live-access".to_string())
        );
    }
}
