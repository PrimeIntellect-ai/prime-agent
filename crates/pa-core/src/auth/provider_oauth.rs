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
                            audience_mode: None,
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
                            audience_mode: None,
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
                                audience_mode: None,
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
                            audience_mode: None,
                        }),
                    // The match arms cover the four subscription ids;
                    // a refresh never dispatches another.
                    _ => Err("unknown subscription provider".to_string()),
                }
            })
            .map_err(|error| format!("the refresh thread could not be spawned: {error}"))?
            .join()
            .map_err(|_| "the refresh thread panicked".to_string())?
            .map_err(|reason| sanitize_refresh_reason(&reason, credential))
    }
}

/// Whether a refresh failure reads as the server refusing the grant — a
/// 400/401/403 refusal in any of the providers' reason formats — rather
/// than a transient endpoint failure (transport, 5xx) or a local mishap
/// (a spawn failure, a malformed response). Only a refusal proves the
/// grant dead; the rest keep the ordinary retry ladder.
pub(crate) fn is_grant_rejection(reason: &str) -> bool {
    [400, 401, 403].iter().any(|status| {
        // Copilot's failure format leads with the bare status
        // ("401 Unauthorized: ...").
        reason.starts_with(&format!("{status} "))
            || reason.contains(&format!("({status})"))
            || reason.contains(&format!("(HTTP {status})"))
            || reason.contains(&format!("status={status}"))
    })
}

/// Credential-shaped material never reaches the log line or the re-login
/// sentence: a provider error body can echo the rejected token back. The
/// loaded credential's exact access and refresh values are redacted
/// wherever they appear (an opaque token has no minimum length), the
/// `body=` tail is dropped, and any word carrying a long
/// credential-shaped run (an opaque token, a JWT) is redacted; short
/// provider phrases like "expired" survive.
fn sanitize_refresh_reason(reason: &str, loaded: &AuthCredential) -> String {
    const SECRET_MIN_CHARS: usize = 16;
    let exact_redacted = match loaded {
        AuthCredential::Oauth {
            access, refresh, ..
        } => {
            // An empty stored value never replaces: `str::replace` with an
            // empty pattern inserts at every character boundary.
            let mut redacted = if access.is_empty() {
                reason.to_string()
            } else {
                reason.replace(access.as_str(), "[redacted]")
            };
            if let Some(refresh) = refresh.as_deref().filter(|refresh| !refresh.is_empty()) {
                redacted = redacted.replace(refresh, "[redacted]");
            }
            redacted
        }
        _ => reason.to_string(),
    };
    let reason = exact_redacted.as_str();
    let truncated = match reason.find("body=") {
        Some(start) => &reason[..start],
        None => reason,
    };
    let carries_secret = |word: &str| {
        let mut run = 0usize;
        for character in word.chars() {
            if character.is_ascii_alphanumeric() || "_-./+=~".contains(character) {
                run += 1;
                if run >= SECRET_MIN_CHARS {
                    return true;
                }
            } else {
                run = 0;
            }
        }
        false
    };
    truncated
        .split_whitespace()
        .map(|word| {
            if carries_secret(word) {
                "[redacted]"
            } else {
                word
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
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
        let credential = credentials.credential(provider_id)?;
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

/// One structured warn line for a failed token exchange.
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

    /// The process-global log sink is shared test state: every test that
    /// swaps it holds this lock for its whole body, so concurrent tests
    /// never capture each other's lines or clobber the sink mid-exchange.
    static SINK_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
            audience_mode: None,
        }
    }

    /// One future-dated codex credential: locally valid, the revoked-session
    /// shape (a server-side rejection before the stored expiry).
    fn live_codex_credential() -> AuthCredential {
        AuthCredential::Oauth {
            access: "rejected-access".to_string(),
            refresh: Some("r-old".to_string()),
            expires: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(i64::MAX, |d| d.as_millis() as i64)
                + 3_600_000,
            account_id: Some("acct-1".to_string()),
            enterprise_url: None,
            endpoint: None,
            token_endpoint: None,
            client_id: None,
            resource: None,
            issuer: None,
            audience_mode: None,
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
                audience_mode: None,
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
                audience_mode: None,
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
        let mut auth = storage_with_credential(OPENAI_CODEX_PROVIDER_ID, &live_codex_credential());
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
        let mut auth = crate::auth::AuthStorage::in_memory_without_env(
            &{
                let mut data = crate::auth::types::AuthStorageData::default();
                data.insert(OPENAI_CODEX_PROVIDER_ID, &live_codex_credential());
                data
            },
            std::sync::Arc::new(ProviderOAuth::with_transports(
                std::sync::Arc::new(ScriptedHttp(HashMap::new())),
                std::sync::Arc::new(ScriptedProviderHttp(HashMap::new())),
            )),
        );
        let outcome = auth.force_refresh_oauth(OPENAI_CODEX_PROVIDER_ID);
        let reason = outcome
            .expect_err("the failed exchange carries its reason")
            .to_string();
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
        let without_refresh = AuthCredential::Oauth {
            access: "stale-access".to_string(),
            refresh: None,
            expires: 1,
            account_id: Some("acct-1".to_string()),
            enterprise_url: None,
            endpoint: None,
            token_endpoint: None,
            client_id: None,
            resource: None,
            issuer: None,
            audience_mode: None,
        };
        let mut auth = storage_with_credential(OPENAI_CODEX_PROVIDER_ID, &without_refresh);
        let outcome = auth.force_refresh_oauth(OPENAI_CODEX_PROVIDER_ID);
        assert_eq!(
            outcome.unwrap_err().to_string(),
            "the stored credential for openai-codex carries no refresh token"
        );
    }

    /// A 401 body echoing the rejected token back never reaches the log
    /// line or the re-login reason: the boundary redacts credential-shaped
    /// material and drops `body=` tails.
    #[test]
    fn a_rejected_exchange_never_leaks_the_echoed_token() {
        let _sink_guard = SINK_LOCK.lock().expect("log sink lock");
        let echoed_token = "sk-ant-o01-echoed-caller-secret-credential";
        let logged = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let sink_logged = Arc::clone(&logged);
        pa_ai::utils::log::set_log_sink(Some(Arc::new(
            move |entry: &pa_ai::utils::log::LogEntry| {
                sink_logged
                    .lock()
                    .expect("log capture lock")
                    .push(serde_json::to_string(entry).unwrap_or_default());
            },
        )));
        let mut codex = HashMap::new();
        codex.insert(
            "https://auth.openai.com/oauth/token".to_string(),
            CodexHttpResponse {
                status: 401,
                body: format!("the token {echoed_token} was revoked"),
            },
        );
        let mut auth = crate::auth::AuthStorage::in_memory_without_env(
            &{
                let mut data = crate::auth::types::AuthStorageData::default();
                data.insert(OPENAI_CODEX_PROVIDER_ID, &live_codex_credential());
                data
            },
            std::sync::Arc::new(ProviderOAuth::with_transports(
                std::sync::Arc::new(ScriptedHttp(codex)),
                std::sync::Arc::new(ScriptedProviderHttp(HashMap::new())),
            )),
        );
        let outcome = auth.force_refresh_oauth(OPENAI_CODEX_PROVIDER_ID);
        pa_ai::utils::log::set_log_sink(None);
        let reason = outcome
            .expect_err("the rejected exchange carries its reason")
            .to_string();
        assert!(
            !reason.contains(echoed_token),
            "the re-login reason never carries the echoed token: {reason}"
        );
        let logged = logged.lock().expect("log capture lock").join(" ");
        assert!(
            !logged.contains(echoed_token),
            "the structured warn line never carries the echoed token: {logged}"
        );
        assert!(
            logged.contains("oauth token refresh failed"),
            "the failure still logs: {logged}"
        );
    }

    /// The stored credential's own short values are equally secret: a
    /// 401 body echoing the five-character refresh token never reaches
    /// the log line or the re-login reason.
    #[test]
    fn a_rejected_exchange_never_leaks_the_short_stored_token() {
        let _sink_guard = SINK_LOCK.lock().expect("log sink lock");
        let short_refresh = "r-old";
        let logged = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let sink_logged = Arc::clone(&logged);
        pa_ai::utils::log::set_log_sink(Some(Arc::new(
            move |entry: &pa_ai::utils::log::LogEntry| {
                sink_logged
                    .lock()
                    .expect("log capture lock")
                    .push(serde_json::to_string(entry).unwrap_or_default());
            },
        )));
        let mut codex = HashMap::new();
        codex.insert(
            "https://auth.openai.com/oauth/token".to_string(),
            CodexHttpResponse {
                status: 401,
                body: format!("rejected {short_refresh}"),
            },
        );
        let mut auth = crate::auth::AuthStorage::in_memory_without_env(
            &{
                let mut data = crate::auth::types::AuthStorageData::default();
                data.insert(OPENAI_CODEX_PROVIDER_ID, &live_codex_credential());
                data
            },
            std::sync::Arc::new(ProviderOAuth::with_transports(
                std::sync::Arc::new(ScriptedHttp(codex)),
                std::sync::Arc::new(ScriptedProviderHttp(HashMap::new())),
            )),
        );
        let outcome = auth.force_refresh_oauth(OPENAI_CODEX_PROVIDER_ID);
        pa_ai::utils::log::set_log_sink(None);
        let reason = outcome
            .expect_err("the rejected exchange carries its reason")
            .to_string();
        assert!(
            !reason.contains(short_refresh),
            "the re-login reason never carries the stored refresh token: {reason}"
        );
        assert!(
            reason.contains("[redacted]"),
            "the echoed token is redacted, not silently trimmed: {reason}"
        );
        let logged = logged.lock().expect("log capture lock").join(" ");
        assert!(
            !logged.contains(short_refresh),
            "the structured warn line never carries the stored refresh token: {logged}"
        );
    }

    /// Only a refusal proves the grant dead: the refusal statuses in
    /// every provider's reason format are rejections; transport failures,
    /// 5xx overloads, and local mishaps are not.
    #[test]
    fn only_a_refusal_status_marks_the_grant_rejected() {
        assert!(is_grant_rejection(
            "OpenAI Codex token refresh failed (401): expired"
        ));
        assert!(is_grant_rejection(
            "xAI OAuth token refresh failed (HTTP 400): authorization expired or revoked; sign in again"
        ));
        assert!(is_grant_rejection(
            "401 Unauthorized: the token was revoked"
        ));
        assert!(!is_grant_rejection(
            "503 Service Unavailable: try again later"
        ));
        assert!(is_grant_rejection(
            "Anthropic token refresh request failed. url=[redacted] details=Error: HTTP request failed. status=403; url=[redacted]"
        ));
        assert!(!is_grant_rejection(
            "OpenAI Codex token refresh failed (503): overloaded"
        ));
        assert!(!is_grant_rejection(
            "Anthropic token refresh request failed. url=[redacted] details=Error: HTTP request failed. status=502; url=[redacted]"
        ));
        assert!(!is_grant_rejection(
            "Anthropic token refresh request failed. url=[redacted] details=Error: HTTP request failed."
        ));
        assert!(!is_grant_rejection("the refresh thread panicked"));
        assert!(!is_grant_rejection(
            "the refresh thread could not be spawned: no capacity"
        ));
        assert!(!is_grant_rejection("response is not valid JSON"));
        assert!(!is_grant_rejection("url was not scripted"));
    }

    #[test]
    fn the_reason_scrubber_keeps_provider_phrases_and_drops_secret_shapes() {
        let loaded = live_codex_credential();
        assert_eq!(
            sanitize_refresh_reason("OpenAI Codex token refresh failed (401): expired", &loaded),
            "OpenAI Codex token refresh failed (401): expired"
        );
        assert_eq!(
            sanitize_refresh_reason(
                "Anthropic token refresh request failed. url=https://platform.claude.com/v1/oauth/token; details=Error: HTTP request failed. status=401; url=https://platform.claude.com/v1/oauth/token; body=secret-tail",
                &loaded
            ),
            "Anthropic token refresh request failed. [redacted] details=Error: HTTP request failed. status=401; [redacted]"
        );
        assert_eq!(
            sanitize_refresh_reason(
                "rejected: sk-ant-o01-echoed-caller-secret-credential",
                &loaded
            ),
            "rejected: [redacted]"
        );
        assert_eq!(
            sanitize_refresh_reason(
                "rejected: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
                &loaded
            ),
            "rejected: [redacted]"
        );
        // The loaded credential's own values are redacted at any length:
        // an opaque token has no minimum, so the shape heuristic alone
        // never carries the stored `r-old` back out.
        assert_eq!(
            sanitize_refresh_reason(
                "OpenAI Codex token refresh failed (401): rejected r-old",
                &loaded
            ),
            "OpenAI Codex token refresh failed (401): rejected [redacted]"
        );
        assert_eq!(
            sanitize_refresh_reason("the rejected-access token was echoed", &loaded),
            "the [redacted] token was echoed"
        );
        // An empty stored access never replaces: `str::replace` with an
        // empty pattern would insert at every character boundary.
        let mut empty_access = live_codex_credential();
        if let AuthCredential::Oauth { access, .. } = &mut empty_access {
            *access = String::new();
        }
        assert_eq!(
            sanitize_refresh_reason("expired", &empty_access),
            "expired",
            "an empty stored access leaves the reason intact"
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
            audience_mode: None,
        };
        let mut auth = storage_with_credential(OPENAI_CODEX_PROVIDER_ID, &unexpired);
        assert_eq!(
            auth.get_api_key(OPENAI_CODEX_PROVIDER_ID),
            Some("live-access".to_string())
        );
    }
}
