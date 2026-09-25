//! The GitHub Copilot OAuth flow — the port of
//! `packages/ai/src/utils/oauth/github-copilot.ts` (+
//! `copilot-client-version.ts`): the optional GitHub Enterprise
//! domain prompt, the device-code flow against the GitHub login
//! endpoints (with the client impersonation headers and the
//! `slow_down` backoff), the Copilot internal token exchange, the
//! model-policy enabling after login, and the token refresh. The
//! credentials the flow returns carry the TS shape (`access`, the
//! GitHub `refresh` token, `expires`, the `enterpriseUrl`) and
//! persist under the provider id `github-copilot`.
//!
//! Cancellation follows the fleet's cooperative pattern (#2770): the
//! driving surface marks a shared flag when it exits; the poll loop
//! checks it between its wait steps, so an exited surface never
//! receives a completed login.

use std::time::Duration;

use url::Url;

use super::provider_http::{ProviderHttp, ProviderHttpMethod, ProviderHttpRequest};
use super::types::{OAuthLoginUi, OAuthPrompt};

/// The OAuth app the TS flow ships (TS stores the id base64-encoded;
/// the decoded value is the wire value).
pub const COPILOT_CLIENT_ID: &str = "Iv1.b507a08c87ecfe98";
/// TS `COPILOT_CLIENT_USER_AGENT` (the client identity the flow and
/// the generated catalog both send — keep both in sync by editing the
/// catalog generator too).
pub const COPILOT_CLIENT_USER_AGENT: &str = "GitHubCopilotChat/0.48.1";
/// TS `COPILOT_CLIENT_HEADERS`.
pub const COPILOT_CLIENT_HEADERS: [(&str, &str); 4] = [
    ("User-Agent", COPILOT_CLIENT_USER_AGENT),
    ("Editor-Version", "vscode/1.136.1"),
    ("Editor-Plugin-Version", "copilot-chat/0.48.1"),
    ("Copilot-Integration-Id", "vscode-chat"),
];
/// TS `INITIAL_POLL_INTERVAL_MULTIPLIER`.
const INITIAL_POLL_INTERVAL_MULTIPLIER: f64 = 1.2;
/// TS `SLOW_DOWN_POLL_INTERVAL_MULTIPLIER`.
const SLOW_DOWN_POLL_INTERVAL_MULTIPLIER: f64 = 1.4;
/// One request's bound (the port's request-timeout norm; TS `fetch`
/// carries no explicit timeout here).
pub const DEFAULT_TOKEN_TIMEOUT_MS: u64 = 30_000;
/// The refresh grant's request bound: the refresh runs under the auth
/// store's file lock, which a peer declares stale after 10 seconds — the
/// request must fit inside that window so a slow endpoint fails the
/// refresh (kept for a retry) instead of holding the lock past its
/// staleness.
pub const REFRESH_TIMEOUT_MS: u64 = 8_000;
/// The credential's expiry skew (TS `5 * 60 * 1000`).
const EXPIRY_SKEW_MS: i64 = 5 * 60 * 1000;
/// The device flow's requested scope (TS `scope: "read:user"`).
const DEVICE_SCOPE: &str = "read:user";
/// The cancel error the driving surface maps to the silent cancelled
/// outcome.
pub const LOGIN_CANCELLED: &str = "Login cancelled";
/// The poll's cancel-check step (#2770 — the flag is checked between
/// the wait steps).
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// The credentials the flow returns and persists (TS
/// `OAuthCredentials` plus the Copilot provider's `enterpriseUrl`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopilotCredentials {
    /// The Copilot internal token (the API's bearer).
    pub access: String,
    /// The GitHub OAuth access token (the refresh source).
    pub refresh: String,
    /// Wall-clock epoch milliseconds (TS `expires_at * 1000 - 5
    /// minutes`).
    pub expires: i64,
    /// The GitHub Enterprise domain the login ran against (`None` for
    /// github.com; TS `enterpriseUrl`).
    pub enterprise_url: Option<String>,
}

/// TS `normalizeDomain`: a URL or bare domain reduced to its hostname
/// (`None` on an empty input or an unparseable one).
pub fn normalize_domain(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    Url::parse(&candidate)
        .ok()
        .map(|url| url.host_str().unwrap_or_default().to_string())
}

/// The provider's endpoint set for one domain (TS `getUrls`).
fn urls_for(domain: &str) -> DeviceUrls {
    DeviceUrls {
        device_code_url: format!("https://{domain}/login/device/code"),
        access_token_url: format!("https://{domain}/login/oauth/access_token"),
        copilot_token_url: format!("https://api.{domain}/copilot_internal/v2/token"),
    }
}

struct DeviceUrls {
    device_code_url: String,
    access_token_url: String,
    copilot_token_url: String,
}

/// TS `getBaseUrlFromToken`: the API base URL the Copilot token
/// carries (`proxy-ep` rewritten onto `api.`), if any.
pub fn get_base_url_from_token(token: &str) -> Option<String> {
    // TS matches `/proxy-ep=([^;]+)/` on the token string.
    let start = token.find("proxy-ep=")?;
    let rest = &token[start + "proxy-ep=".len()..];
    let proxy_host = rest.split(';').next().unwrap_or_default();
    if proxy_host.is_empty() {
        return None;
    }
    let api_host = proxy_host.strip_prefix("proxy.").unwrap_or(proxy_host);
    Some(format!("https://{api_host}"))
}

/// TS `getGitHubCopilotBaseUrl`: the token's carried endpoint wins,
/// then the enterprise domain, then the individual default.
pub fn get_github_copilot_base_url(token: Option<&str>, enterprise_domain: Option<&str>) -> String {
    if let Some(url) = token.and_then(get_base_url_from_token) {
        return url;
    }
    if let Some(domain) = enterprise_domain {
        return format!("https://copilot-api.{domain}");
    }
    "https://api.individual.githubcopilot.com".to_string()
}

/// Run the login (TS `loginGitHubCopilot`): the optional enterprise
/// domain prompt, the device flow, the Copilot token exchange, and
/// the model-policy enabling.
///
/// # Errors
///
/// Returns an error when the surface cancelled the login
/// ([`LOGIN_CANCELLED`]), the enterprise input is not a domain, the
/// device flow fails or times out, or the Copilot token exchange
/// fails.
pub async fn login_github_copilot(
    http: &dyn ProviderHttp,
    ui: &dyn OAuthLoginUi,
) -> Result<CopilotCredentials, String> {
    // An exited surface never starts: no prompt, no browser launch (the
    // #2770 flag is the seam).
    if ui.is_cancelled() {
        return Err(LOGIN_CANCELLED.to_string());
    }
    let input = ui
        .on_prompt(&OAuthPrompt {
            message: "GitHub Enterprise URL/domain (blank for github.com)".to_string(),
            placeholder: Some("company.ghe.com".to_string()),
            allow_empty: true,
        })
        .await
        .ok_or_else(|| LOGIN_CANCELLED.to_string())?;
    if ui.is_cancelled() {
        return Err(LOGIN_CANCELLED.to_string());
    }
    let trimmed = input.trim();
    let enterprise_domain = normalize_domain(&input);
    if !trimmed.is_empty() && enterprise_domain.is_none() {
        return Err("Invalid GitHub Enterprise URL/domain".to_string());
    }
    let domain = enterprise_domain
        .clone()
        .unwrap_or_else(|| "github.com".to_string());

    let device = start_device_flow(http, &domain).await?;
    ui.on_auth(
        &device.verification_uri,
        Some(&format!("Enter code: {device.user_code}")),
    );
    let github_access_token = poll_for_github_access_token(http, &domain, &device, ui).await?;
    let credentials =
        refresh_github_copilot_token(http, &github_access_token, enterprise_domain.as_deref())
            .await?;
    ui.on_progress("Enabling models...");
    enable_all_github_copilot_models(http, &credentials.access, enterprise_domain.as_deref()).await;
    Ok(credentials)
}

/// Refresh an expired credential (TS `refreshGitHubCopilotToken`):
/// the stored GitHub token exchanges for a fresh Copilot internal
/// token.
///
/// # Errors
///
/// Returns an error when the Copilot token endpoint fails.
pub async fn refresh_github_copilot_token(
    http: &dyn ProviderHttp,
    github_access_token: &str,
    enterprise_domain: Option<&str>,
) -> Result<CopilotCredentials, String> {
    let domain = enterprise_domain.unwrap_or("github.com");
    let urls = urls_for(domain);
    let mut headers = vec![
        ("Accept".to_string(), "application/json".to_string()),
        (
            "Authorization".to_string(),
            format!("Bearer {github_access_token}"),
        ),
    ];
    for (name, value) in COPILOT_CLIENT_HEADERS {
        headers.push((name.to_string(), value.to_string()));
    }
    // The refresh runs under the auth store's lock: the request fits
    // inside the lock's staleness window (REFRESH_TIMEOUT_MS).
    let response = http
        .request(
            ProviderHttpRequest {
                method: ProviderHttpMethod::Get,
                url: urls.copilot_token_url,
                headers,
                body: None,
                follow_redirects: true,
            },
            REFRESH_TIMEOUT_MS,
        )
        .await?;
    if !response.ok() {
        return Err(format!(
            "{} {}: {}",
            response.status,
            status_text(response.status),
            response.body
        ));
    }
    let json: serde_json::Value = serde_json::from_str(&response.body)
        .map_err(|_| "Invalid Copilot token response".to_string())?;
    let token = json
        .get("token")
        .and_then(serde_json::Value::as_str)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| "Invalid Copilot token response fields".to_string())?
        .to_string();
    let expires_at = json
        .get("expires_at")
        .and_then(serde_json::Value::as_f64)
        .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
        .ok_or_else(|| "Invalid Copilot token response fields".to_string())?;
    Ok(CopilotCredentials {
        access: token,
        refresh: github_access_token.to_string(),
        expires: ((expires_at * 1000.0) as i64).saturating_sub(EXPIRY_SKEW_MS),
        enterprise_url: enterprise_domain.map(str::to_string),
    })
}

/// TS `enableAllGitHubCopilotModels`: enable every catalog model's
/// policy after login so the subscription models are usable
/// (failures are ignored — the account may already carry some).
async fn enable_all_github_copilot_models(
    http: &dyn ProviderHttp,
    token: &str,
    enterprise_domain: Option<&str>,
) {
    let base_url = get_github_copilot_base_url(Some(token), enterprise_domain);
    for model in crate::models_generated::get_models("github-copilot") {
        let url = format!("{base_url}/models/{}/policy", model.id);
        let mut headers = vec![
            ("Content-Type".to_string(), "application/json".to_string()),
            ("Authorization".to_string(), format!("Bearer {token}")),
        ];
        for (name, value) in COPILOT_CLIENT_HEADERS {
            headers.push((name.to_string(), value.to_string()));
        }
        headers.push(("openai-intent".to_string(), "chat-policy".to_string()));
        headers.push(("x-interaction-type".to_string(), "chat-policy".to_string()));
        let request = ProviderHttpRequest {
            method: ProviderHttpMethod::Post,
            url,
            headers,
            body: Some(r#"{"state":"enabled"}"#.to_string()),
            follow_redirects: true,
        };
        // TS swallows both the failed status and the thrown request.
        if let Ok(response) = http.request(request, DEFAULT_TOKEN_TIMEOUT_MS).await {
            let _ = response.ok();
        }
    }
}

/// One device-code response (TS `DeviceCodeResponse`).
struct DeviceCode {
    device_code: String,
    user_code: String,
    verification_uri: String,
    interval: u64,
    expires_in: u64,
}

/// TS `startDeviceFlow`: the device authorization request with the
/// client's user agent.
async fn start_device_flow(http: &dyn ProviderHttp, domain: &str) -> Result<DeviceCode, String> {
    let urls = urls_for(domain);
    let body = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs([("client_id", COPILOT_CLIENT_ID), ("scope", DEVICE_SCOPE)])
        .finish();
    let response = http
        .request(
            ProviderHttpRequest {
                method: ProviderHttpMethod::Post,
                url: urls.device_code_url,
                headers: vec![
                    ("Accept".to_string(), "application/json".to_string()),
                    (
                        "Content-Type".to_string(),
                        "application/x-www-form-urlencoded".to_string(),
                    ),
                    (
                        "User-Agent".to_string(),
                        COPILOT_CLIENT_USER_AGENT.to_string(),
                    ),
                ],
                body: Some(body),
                follow_redirects: true,
            },
            DEFAULT_TOKEN_TIMEOUT_MS,
        )
        .await?;
    if !response.ok() {
        // TS `fetchJson` throws the `status statusText: text` form.
        return Err(format!(
            "{} {}: {}",
            response.status,
            status_text(response.status),
            response.body
        ));
    }
    let json: serde_json::Value = serde_json::from_str(&response.body)
        .map_err(|_| "Invalid device code response".to_string())?;
    let field = |name: &str| {
        json.get(name)
            .map(serde_json::Value::clone)
            .ok_or_else(|| "Invalid device code response fields".to_string())
    };
    let device_code = field("device_code")?
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Invalid device code response fields".to_string())?
        .to_string();
    let user_code = field("user_code")?
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Invalid device code response fields".to_string())?
        .to_string();
    let verification_uri = field("verification_uri")?
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Invalid device code response fields".to_string())?
        .to_string();
    let interval = field("interval")?
        .as_f64()
        .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
        .ok_or_else(|| "Invalid device code response fields".to_string())?;
    let expires_in = field("expires_in")?
        .as_f64()
        .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
        .ok_or_else(|| "Invalid device code response fields".to_string())?;
    Ok(DeviceCode {
        device_code,
        user_code,
        verification_uri,
        interval: interval as u64,
        expires_in: expires_in as u64,
    })
}

/// TS `pollForGitHubAccessToken`: the device-code grant poll with the
/// TS backoff (the 1.2x initial multiplier, the 1.4x `slow_down`
/// multiplier, and the `slow_down` interval bump) and the cooperative
/// cancel between the wait steps.
async fn poll_for_github_access_token(
    http: &dyn ProviderHttp,
    domain: &str,
    device: &DeviceCode,
    ui: &dyn OAuthLoginUi,
) -> Result<String, String> {
    let urls = urls_for(domain);
    let deadline = std::time::Instant::now() + Duration::from_secs(device.expires_in);
    let mut interval_ms = (device.interval * 1000).max(1000);
    let mut interval_multiplier = INITIAL_POLL_INTERVAL_MULTIPLIER;
    let mut slow_down_responses = 0;
    while std::time::Instant::now() < deadline {
        if ui.is_cancelled() {
            return Err(LOGIN_CANCELLED.to_string());
        }
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        let wait_ms = ((interval_ms as f64 * interval_multiplier).ceil() as u64)
            .min(remaining.as_millis() as u64);
        cancel_aware_sleep(ui, Duration::from_millis(wait_ms)).await?;

        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs([
                ("client_id", COPILOT_CLIENT_ID),
                ("device_code", device.device_code.as_str()),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .finish();
        let response = http
            .request(
                ProviderHttpRequest {
                    method: ProviderHttpMethod::Post,
                    url: urls.access_token_url.clone(),
                    headers: vec![
                        ("Accept".to_string(), "application/json".to_string()),
                        (
                            "Content-Type".to_string(),
                            "application/x-www-form-urlencoded".to_string(),
                        ),
                        (
                            "User-Agent".to_string(),
                            COPILOT_CLIENT_USER_AGENT.to_string(),
                        ),
                    ],
                    body: Some(body),
                    follow_redirects: true,
                },
                DEFAULT_TOKEN_TIMEOUT_MS,
            )
            .await?;
        if !response.ok() {
            // TS `fetchJson` throws the `status statusText: text` form.
            return Err(format!(
                "{} {}: {}",
                response.status,
                status_text(response.status),
                response.body
            ));
        }
        let json: serde_json::Value = serde_json::from_str(&response.body)
            .map_err(|_| "Invalid device code response".to_string())?;
        if let Some(access_token) = json
            .get("access_token")
            .and_then(serde_json::Value::as_str)
            .filter(|token| !token.is_empty())
        {
            return Ok(access_token.to_string());
        }
        let error = json
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        match error.as_str() {
            "authorization_pending" => continue,
            "slow_down" => {
                slow_down_responses += 1;
                let advertised = json
                    .get("interval")
                    .and_then(serde_json::Value::as_f64)
                    .filter(|seconds| *seconds > 0.0);
                interval_ms = advertised
                    .map(|seconds| (seconds * 1000.0) as u64)
                    .unwrap_or((interval_ms + 5000).max(1000));
                interval_multiplier = SLOW_DOWN_POLL_INTERVAL_MULTIPLIER;
                continue;
            }
            other => {
                let description = json
                    .get("error_description")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                let suffix = if description.is_empty() {
                    String::new()
                } else {
                    format!(": {description}")
                };
                return Err(format!("Device flow failed: {other}{suffix}"));
            }
        }
    }
    if slow_down_responses > 0 {
        return Err("Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again.".to_string());
    }
    Err("Device flow timed out".to_string())
}

/// One abortable wait (TS `abortableSleep`): the cooperative cancel
/// ends it mid-wait instead of the abort signal.
async fn cancel_aware_sleep(ui: &dyn OAuthLoginUi, total: Duration) -> Result<(), String> {
    let deadline = std::time::Instant::now() + total;
    loop {
        if ui.is_cancelled() {
            return Err(LOGIN_CANCELLED.to_string());
        }
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Ok(());
        }
        tokio::time::sleep(remaining.min(CANCEL_POLL_INTERVAL)).await;
    }
}

/// TS `response.statusText` (a reason phrase per status).
fn status_text(status: u16) -> &'static str {
    match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        408 => "Request Timeout",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, VecDeque};
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    /// A scripted transport: queued responses per url (popped in
    /// order), a static map, and a catch-all default for the model
    /// policy POSTs; every request is recorded.
    struct ScriptedHttp {
        queued: Mutex<HashMap<String, VecDeque<ProviderHttpResponse>>>,
        fixed: HashMap<String, ProviderHttpResponse>,
        catch_all: Option<ProviderHttpResponse>,
        requests: Mutex<Vec<ProviderHttpRequest>>,
    }

    impl ScriptedHttp {
        fn new() -> Self {
            ScriptedHttp {
                queued: Mutex::new(HashMap::new()),
                fixed: HashMap::new(),
                catch_all: None,
                requests: Mutex::new(Vec::new()),
            }
        }

        fn entry(status: u16, body: &str) -> ProviderHttpResponse {
            ProviderHttpResponse {
                status,
                body: body.to_string(),
            }
        }

        fn queue(mut self, url: &str, responses: Vec<ProviderHttpResponse>) -> Self {
            self.queued.lock().unwrap().insert(
                url.to_string(),
                responses.into_iter().collect::<VecDeque<_>>(),
            );
            self
        }

        fn fixed(mut self, url: &str, response: ProviderHttpResponse) -> Self {
            self.fixed.insert(url.to_string(), response);
            self
        }

        fn catch_all(mut self, response: ProviderHttpResponse) -> Self {
            self.catch_all = Some(response);
            self
        }

        fn bodies_for(&self, url_prefix: &str) -> Vec<ProviderHttpRequest> {
            self.requests
                .lock()
                .unwrap()
                .iter()
                .filter(|request| request.url.starts_with(url_prefix))
                .cloned()
                .collect()
        }
    }

    impl ProviderHttp for ScriptedHttp {
        fn request(
            &self,
            request: ProviderHttpRequest,
            _timeout_ms: u64,
        ) -> Pin<Box<dyn Future<Output = Result<ProviderHttpResponse, String>> + Send + '_>>
        {
            self.requests.lock().unwrap().push(request.clone());
            let response = self
                .queued
                .lock()
                .unwrap()
                .get_mut(&request.url)
                .and_then(|queue| queue.pop_front())
                .or_else(|| self.fixed.get(&request.url).cloned())
                .or_else(|| self.catch_all.clone());
            Box::pin(
                async move { response.ok_or_else(|| format!("{request.url} was not scripted")) },
            )
        }
    }

    /// One scripted UI answer.
    enum ScriptedAnswer {
        Once(Option<String>),
        Pending,
    }

    impl ScriptedAnswer {
        fn ready() -> Self {
            ScriptedAnswer::Once(None)
        }

        fn value(text: &str) -> Self {
            ScriptedAnswer::Once(Some(text.to_string()))
        }

        fn future(&self) -> Pin<Box<dyn Future<Output = Option<String>> + Send>> {
            match self {
                ScriptedAnswer::Once(value) => {
                    let value = value.clone();
                    Box::pin(std::future::ready(value))
                }
                ScriptedAnswer::Pending => Box::pin(std::future::pending()),
            }
        }
    }

    /// The scripted login surface: the enterprise prompt, the auth
    /// block, the progress lines, and the cancel flag.
    struct ScriptedUi {
        prompt: ScriptedAnswer,
        auth_url: Mutex<Option<String>>,
        auth_instructions: Mutex<Option<String>>,
        progress: Mutex<Vec<String>>,
        cancelled: Arc<AtomicBool>,
        cancel_after_prompt: bool,
    }

    impl ScriptedUi {
        fn new(prompt: ScriptedAnswer) -> Self {
            ScriptedUi {
                prompt,
                auth_url: Mutex::new(None),
                auth_instructions: Mutex::new(None),
                progress: Mutex::new(Vec::new()),
                cancelled: Arc::new(AtomicBool::new(false)),
                cancel_after_prompt: false,
            }
        }

        fn captured_auth(&self) -> (String, Option<String>) {
            (
                self.auth_url.lock().unwrap().clone().expect("the auth url"),
                self.auth_instructions.lock().unwrap().clone(),
            )
        }
    }

    impl OAuthLoginUi for ScriptedUi {
        fn on_auth(&self, url: &str, instructions: Option<&str>) {
            *self.auth_url.lock().unwrap() = Some(url.to_string());
            *self.auth_instructions.lock().unwrap() = instructions.map(str::to_string);
        }

        fn on_prompt(
            &self,
            prompt: &OAuthPrompt,
        ) -> Pin<Box<dyn Future<Output = Option<String>> + Send + '_>> {
            assert_eq!(
                prompt.message,
                "GitHub Enterprise URL/domain (blank for github.com)"
            );
            assert_eq!(prompt.placeholder.as_deref(), Some("company.ghe.com"));
            assert!(
                prompt.allow_empty,
                "the blank entry is the github.com default"
            );
            if self.cancel_after_prompt {
                self.cancelled.store(true, Ordering::Relaxed);
            }
            let answer = self.prompt.future();
            Box::pin(async move { answer.await })
        }

        fn on_progress(&self, message: &str) {
            self.progress.lock().unwrap().push(message.to_string());
        }

        fn on_manual_code_input(
            &self,
        ) -> Option<Pin<Box<dyn Future<Output = Option<String>> + Send + '_>>> {
            None
        }

        fn is_cancelled(&self) -> bool {
            self.cancelled.load(Ordering::Relaxed)
        }
    }

    /// The github.com happy flow's scripted endpoints (a fast poll:
    /// interval 0, pending once, then the token).
    fn github_http() -> ScriptedHttp {
        ScriptedHttp::new()
            .queue(
                "https://github.com/login/device/code",
                vec![ScriptedHttp::entry(
                    200,
                    r#"{"device_code":"dev-1","user_code":"ABCD-1234","verification_uri":"https://github.com/login/device","interval":0,"expires_in":900}"#,
                )],
            )
            .queue(
                "https://github.com/login/oauth/access_token",
                vec![
                    ScriptedHttp::entry(200, r#"{"error":"authorization_pending"}"#),
                    ScriptedHttp::entry(200, r#"{"access_token":"gh-token"}"#),
                ],
            )
            .fixed(
                "https://api.github.com/copilot_internal/v2/token",
                ScriptedHttp::entry(
                    200,
                    r#"{"token":"copilot-token","expires_at":4_000_000_000}"#,
                ),
            )
            .catch_all(ScriptedHttp::entry(200, "{}"))
    }

    #[tokio::test]
    async fn the_device_flow_bodies_match_the_ts_grants() {
        let http = github_http();
        let ui = ScriptedUi::new(ScriptedAnswer::value(""));
        let credentials = login_github_copilot(&http, &ui).await.unwrap();
        assert_eq!(credentials.access, "copilot-token");
        assert_eq!(credentials.refresh, "gh-token");
        assert_eq!(credentials.enterprise_url, None);
        // The device-code request: the client id and the scope.
        let device = &http.bodies_for("https://github.com/login/device/code")[0];
        assert!(device
            .body
            .as_deref()
            .unwrap()
            .contains("client_id=Iv1.b507a08c87ecfe98"));
        assert!(device
            .body
            .as_deref()
            .unwrap()
            .contains("scope=read%3Auser"));
        // The poll request: the device-code grant.
        let poll = &http.bodies_for("https://github.com/login/oauth/access_token")[1];
        let body = poll.body.as_deref().unwrap();
        assert!(body.contains("device_code=dev-1"));
        assert!(body.contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code"));
        // The Copilot token exchange: the impersonation headers ride.
        let internal = &http.bodies_for("https://api.github.com/copilot_internal/v2/token")[0];
        assert_eq!(internal.method, ProviderHttpMethod::Get);
        let header = |name: &str| {
            internal
                .headers
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
                .expect("the header rides")
        };
        assert_eq!(header("Authorization"), "Bearer gh-token");
        assert_eq!(header("Editor-Version"), "vscode/1.136.1");
        assert_eq!(header("Copilot-Integration-Id"), "vscode-chat");
        // The auth block carries the TS user-code line.
        let (url, instructions) = ui.captured_auth();
        assert_eq!(url, "https://github.com/login/device");
        assert_eq!(instructions.as_deref(), Some("Enter code: ABCD-1234"));
        // TS: expires = expires_at * 1000 - 5 minutes.
        assert_eq!(credentials.expires, 4_000_000_000_000 - EXPIRY_SKEW_MS);
        // The model-policy pass runs for every catalog model with the
        // policy body.
        let policies = http.bodies_for("https://api.individual.githubcopilot.com/models/");
        let models = crate::models_generated::get_models("github-copilot");
        assert_eq!(
            policies.len(),
            models.len(),
            "every catalog model is enabled"
        );
        for policy in &policies {
            assert_eq!(policy.method, ProviderHttpMethod::Post);
            assert_eq!(policy.body.as_deref(), Some(r#"{"state":"enabled"}"#));
            assert!(policy.headers.iter().any(|(key, _)| key == "openai-intent"));
            assert!(policy
                .headers
                .iter()
                .any(|(key, _)| key == "x-interaction-type"));
        }
        assert!(ui
            .progress
            .lock()
            .unwrap()
            .iter()
            .any(|message| message == "Enabling models..."));
    }

    #[tokio::test]
    async fn an_enterprise_domain_routes_every_endpoint() {
        let http = ScriptedHttp::new()
            .queue(
                "https://company.ghe.com/login/device/code",
                vec![ScriptedHttp::entry(
                    200,
                    r#"{"device_code":"dev-1","user_code":"CODE-1","verification_uri":"https://github.com/login/device","interval":0,"expires_in":900}"#,
                )],
            )
            .queue(
                "https://company.ghe.com/login/oauth/access_token",
                vec![ScriptedHttp::entry(200, r#"{"access_token":"gh-e"}"#)],
            )
            .fixed(
                "https://api.company.ghe.com/copilot_internal/v2/token",
                ScriptedHttp::entry(200, r#"{"token":"copilot-e","expires_at":4_000_000_000}"#),
            )
            .catch_all(ScriptedHttp::entry(200, "{}"));
        let ui = ScriptedUi::new(ScriptedAnswer::value("company.ghe.com"));
        let credentials = login_github_copilot(&http, &ui).await.unwrap();
        assert_eq!(
            credentials.enterprise_url.as_deref(),
            Some("company.ghe.com")
        );
        assert_eq!(credentials.access, "copilot-e");
        // The policy pass routes onto the enterprise base URL.
        assert!(!http
            .bodies_for("https://copilot-api.company.ghe.com/models/")
            .is_empty());
    }

    #[tokio::test]
    async fn an_invalid_enterprise_input_fails_the_ts_error() {
        let http = ScriptedHttp::new();
        let ui = ScriptedUi::new(ScriptedAnswer::value("not a domain"));
        let error = login_github_copilot(&http, &ui).await.unwrap_err();
        assert_eq!(error, "Invalid GitHub Enterprise URL/domain");
        assert!(http.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_cancelled_prompt_ends_the_login() {
        let http = github_http();
        let ui = ScriptedUi::new(ScriptedAnswer::ready());
        let error = login_github_copilot(&http, &ui).await.unwrap_err();
        assert_eq!(error, LOGIN_CANCELLED);
    }

    #[tokio::test]
    async fn a_cancelled_surface_ends_the_poll_between_waits() {
        let http = ScriptedHttp::new()
            .queue(
                "https://github.com/login/device/code",
                vec![ScriptedHttp::entry(
                    200,
                    r#"{"device_code":"dev-1","user_code":"CODE-1","verification_uri":"https://github.com/login/device","interval":0,"expires_in":900}"#,
                )],
            )
            // The poll never answers a token; the cancel flips after the
            // auth block lands.
            .catch_all(ScriptedHttp::entry(
                200,
                r#"{"error":"authorization_pending"}"#,
            ));
        let ui = Arc::new(ScriptedUi::new(ScriptedAnswer::value("")));
        let flag = Arc::clone(&ui.cancelled);
        let flow_ui = Arc::clone(&ui);
        let flow = {
            let flow_http = Arc::new(http);
            tokio::spawn(
                async move { login_github_copilot(flow_http.as_ref(), flow_ui.as_ref()).await },
            )
        };
        // Readiness-wait for the URL (bounded: a missing URL fails the
        // test instead of hanging the cancel flip).
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while flow_ui.auth_url.lock().unwrap().is_none() {
            assert!(
                std::time::Instant::now() < deadline,
                "the flow never presented its url"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        flag.store(true, Ordering::Relaxed);
        let error = tokio::time::timeout(Duration::from_secs(10), flow)
            .await
            .expect("the cancelled poll settles promptly")
            .unwrap()
            .unwrap_err();
        assert_eq!(error, LOGIN_CANCELLED);
    }

    #[tokio::test]
    async fn a_failed_device_flow_surfaces_the_ts_message() {
        let http = ScriptedHttp::new().queue(
            "https://github.com/login/device/code",
            vec![ScriptedHttp::entry(500, "boom")],
        );
        let ui = ScriptedUi::new(ScriptedAnswer::value(""));
        let error = login_github_copilot(&http, &ui).await.unwrap_err();
        assert_eq!(error, "500 Internal Server Error: boom");
    }

    #[tokio::test]
    async fn a_denied_authorization_surfaces_the_ts_message() {
        let http = ScriptedHttp::new()
            .queue(
                "https://github.com/login/device/code",
                vec![ScriptedHttp::entry(
                    200,
                    r#"{"device_code":"dev-1","user_code":"CODE-1","verification_uri":"https://github.com/login/device","interval":0,"expires_in":900}"#,
                )],
            )
            .queue(
                "https://github.com/login/oauth/access_token",
                vec![ScriptedHttp::entry(
                    200,
                    r#"{"error":"access_denied","error_description":"user denied"}"#,
                )],
            );
        let ui = ScriptedUi::new(ScriptedAnswer::value(""));
        let error = login_github_copilot(&http, &ui).await.unwrap_err();
        assert_eq!(error, "Device flow failed: access_denied: user denied");
    }

    #[tokio::test]
    async fn an_invalid_copilot_token_response_fails_the_fields() {
        let http = ScriptedHttp::new()
            .queue(
                "https://github.com/login/device/code",
                vec![ScriptedHttp::entry(
                    200,
                    r#"{"device_code":"dev-1","user_code":"CODE-1","verification_uri":"https://github.com/login/device","interval":0,"expires_in":900}"#,
                )],
            )
            .queue(
                "https://github.com/login/oauth/access_token",
                vec![ScriptedHttp::entry(200, r#"{"access_token":"gh"}"#)],
            )
            .fixed(
                "https://api.github.com/copilot_internal/v2/token",
                ScriptedHttp::entry(200, r#"{"token":"t"}"#),
            );
        let ui = ScriptedUi::new(ScriptedAnswer::value(""));
        let error = login_github_copilot(&http, &ui).await.unwrap_err();
        assert_eq!(error, "Invalid Copilot token response fields");
    }

    #[tokio::test]
    async fn the_refresh_exchanges_the_stored_github_token() {
        let http = ScriptedHttp::new().fixed(
            "https://api.github.com/copilot_internal/v2/token",
            ScriptedHttp::entry(
                200,
                r#"{"token":"copilot-fresh","expires_at":4_000_000_000}"#,
            ),
        );
        let credentials = refresh_github_copilot_token(&http, "gh-old", None)
            .await
            .unwrap();
        assert_eq!(credentials.access, "copilot-fresh");
        assert_eq!(credentials.refresh, "gh-old");
        assert_eq!(credentials.expires, 4_000_000_000_000 - EXPIRY_SKEW_MS);
        let enterprise = refresh_github_copilot_token(&http, "gh-e", Some("company.ghe.com"))
            .await
            .unwrap();
        assert_eq!(
            enterprise.enterprise_url.as_deref(),
            Some("company.ghe.com")
        );
    }

    #[test]
    fn the_domain_and_base_url_helpers_match_the_ts_rules() {
        assert_eq!(normalize_domain("  "), None);
        assert_eq!(
            normalize_domain("company.ghe.com").as_deref(),
            Some("company.ghe.com")
        );
        assert_eq!(
            normalize_domain("https://company.ghe.com/x").as_deref(),
            Some("company.ghe.com")
        );
        assert_eq!(normalize_domain("not a domain"), None);
        // The token's proxy endpoint rewrites onto api.
        assert_eq!(
            get_base_url_from_token("tid=1;exp=2;proxy-ep=proxy.individual.githubcopilot.com;x=3")
                .as_deref(),
            Some("https://api.individual.githubcopilot.com")
        );
        assert_eq!(get_base_url_from_token("tid=1"), None);
        assert_eq!(
            get_github_copilot_base_url(None, None),
            "https://api.individual.githubcopilot.com"
        );
        assert_eq!(
            get_github_copilot_base_url(None, Some("company.ghe.com")),
            "https://copilot-api.company.ghe.com"
        );
        assert_eq!(
            get_github_copilot_base_url(
                Some("proxy-ep=proxy.enterprise.githubcopilot.com"),
                Some("company.ghe.com")
            ),
            "https://api.enterprise.githubcopilot.com"
        );
    }
}
