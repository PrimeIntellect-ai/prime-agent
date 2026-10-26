//! The Meta (Muse subscription) OAuth flow: the Meta device-code flow
//! plus the Model API key mint, ported from the pi agent's `meta.ts`.
//!
//! Login: device authorization at `auth.meta.com` (form-encoded `client_id`)
//! presents a user code + verification URI; polling the device token endpoint
//! yields an identity token; the identity token mints a 24-hour Model API key
//! at `api.meta.ai/muse-code/key`. The minted API key stores as the
//! credential's access token and the identity token as its refresh token, so
//! expiry refresh is a fresh mint.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use url::Url;

use super::provider_http::{ProviderHttp, ProviderHttpMethod, ProviderHttpRequest};
use super::types::OAuthLoginUi;

/// The Muse OAuth client id (the pi agent's public client).
pub const META_CLIENT_ID: &str = "1031625952748946";
const DEVICE_AUTHORIZATION_URL: &str = "https://auth.meta.com/oidc/device/authorization/";
const DEVICE_TOKEN_URL: &str = "https://auth.meta.com/oidc/device/token/";
const API_KEY_MINT_URL: &str = "https://api.meta.ai/muse-code/key";
/// The minted API key lifetime: 24 hours (the pi agent's `API_KEY_LIFETIME_MS`).
pub const API_KEY_LIFETIME_MS: i64 = 24 * 60 * 60 * 1000;
pub const REQUEST_TIMEOUT_MS: u64 = 30_000;
/// The refresh runs under the auth store's file lock, which a peer declares stale after 10 seconds;
/// the request must fit inside that window.
pub const REFRESH_TIMEOUT_MS: u64 = 8_000;
/// The cancel error the driving surface maps to the silent cancelled outcome.
pub const LOGIN_CANCELLED: &str = "Login cancelled";
const DEVICE_FLOW_TIMEOUT_MESSAGE: &str = "Device flow timed out";
const SLOW_DOWN_TIMEOUT_MESSAGE: &str =
    "Device flow timed out after one or more slow_down responses. \
    This is often caused by clock drift in WSL or VM environments. \
    Please sync or restart the VM clock and try again.";
/// The poll interval when the response carries none.
const DEFAULT_POLL_INTERVAL_MS: u64 = 5000;
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetaCredentials {
    /// The minted Model API key (the request credential).
    pub access: String,
    /// The identity token (mints fresh API keys on refresh).
    pub refresh: String,
    /// Wall-clock epoch milliseconds.
    pub expires: i64,
}

/// The status plus the parsed body (an empty object when the body is
/// not one).
struct MetaResponse {
    ok: bool,
    status: u16,
    body: serde_json::Map<String, serde_json::Value>,
}

/// The device authorization, the user code, the identity token poll, and the
/// Model API key mint.
///
/// # Errors
///
/// Returns an error when the login is cancelled ([`LOGIN_CANCELLED`]), the device
/// authorization fails, the code expires, or the key mint fails validation.
pub async fn login_meta(
    http: &dyn ProviderHttp,
    ui: &dyn OAuthLoginUi,
) -> Result<MetaCredentials, String> {
    if ui.is_cancelled() {
        return Err(LOGIN_CANCELLED.to_string());
    }
    let device = start_device_authorization(http, ui).await?;
    ui.on_auth(
        &device.verification_uri,
        Some(&format!("Enter code: {}", device.user_code)),
    );
    let identity_token = poll_for_identity_token(http, ui, &device).await?;
    ui.on_progress("Enabling Meta Model API access...");
    if ui.is_cancelled() {
        return Err(LOGIN_CANCELLED.to_string());
    }
    mint_api_key(http, ui, &identity_token, REQUEST_TIMEOUT_MS).await
}

/// Mint a fresh Model API key from the stored identity token.
///
/// # Errors
///
/// Returns an error when the mint request fails or the response fails validation.
pub async fn refresh_meta_token(
    http: &dyn ProviderHttp,
    identity_token: &str,
) -> Result<MetaCredentials, String> {
    mint_api_key(http, &NoCancel, identity_token, REFRESH_TIMEOUT_MS).await
}

/// The refresh runs detached from any interactive surface.
struct NoCancel;

impl OAuthLoginUi for NoCancel {
    fn on_auth(&self, _url: &str, _instructions: Option<&str>) {}
    fn on_prompt(
        &self,
        _prompt: &super::types::OAuthPrompt,
    ) -> Pin<Box<dyn Future<Output = Option<String>> + Send + '_>> {
        Box::pin(std::future::pending())
    }
    fn on_progress(&self, _message: &str) {}
    fn on_manual_code_input(
        &self,
    ) -> Option<Pin<Box<dyn Future<Output = Option<String>> + Send + '_>>> {
        None
    }
}

struct DeviceAuthorization {
    device_code: String,
    user_code: String,
    verification_uri: String,
    interval_ms: u64,
    /// Absent when the endpoint omits `expires_in` (the pi agent then polls
    /// until cancelled).
    deadline: Option<std::time::Instant>,
}

async fn start_device_authorization(
    http: &dyn ProviderHttp,
    ui: &dyn OAuthLoginUi,
) -> Result<DeviceAuthorization, String> {
    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("client_id", META_CLIENT_ID)
        .finish();
    let response = request(
        http,
        ui,
        ProviderHttpRequest {
            method: ProviderHttpMethod::Post,
            url: DEVICE_AUTHORIZATION_URL.to_string(),
            headers: vec![
                ("Accept".to_string(), "application/json".to_string()),
                (
                    "Content-Type".to_string(),
                    "application/x-www-form-urlencoded".to_string(),
                ),
            ],
            body: Some(body),
            follow_redirects: false,
        },
        REQUEST_TIMEOUT_MS,
        "Meta OAuth request failed. Check your connection and try again.",
    )
    .await?;
    if !response.ok {
        return Err(format!(
            "Meta device authorization failed with status {}{}",
            response.status,
            error_detail(&response.body)
        ));
    }
    let device_code = response
        .body
        .get("device_code")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);
    let user_code = response
        .body
        .get("user_code")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);
    let verification_uri = response
        .body
        .get("verification_uri_complete")
        .or_else(|| response.body.get("verification_uri"))
        .and_then(serde_json::Value::as_str)
        .and_then(|raw| verification_uri(raw).ok());
    let (Some(device_code), Some(user_code), Some(verification_uri)) =
        (device_code, user_code, verification_uri)
    else {
        return Err(format!(
            "Invalid Meta device authorization response: {}",
            serde_json::Value::Object(response.body)
        ));
    };
    // The wire's interval is a positive f64 second count; u64 ms is the poll's unit.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let interval_ms = response
        .body
        .get("interval")
        .and_then(serde_json::Value::as_f64)
        .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
        .map_or(DEFAULT_POLL_INTERVAL_MS, |seconds| {
            ((seconds * 1000.0) as u64).max(1000)
        });
    // The wire's expires_in is an integer second count read through JSON f64.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let deadline = response
        .body
        .get("expires_in")
        .and_then(serde_json::Value::as_f64)
        .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
        .map(|seconds| std::time::Instant::now() + Duration::from_secs(seconds as u64));
    Ok(DeviceAuthorization {
        device_code,
        user_code,
        verification_uri,
        interval_ms,
        deadline,
    })
}

async fn poll_for_identity_token(
    http: &dyn ProviderHttp,
    ui: &dyn OAuthLoginUi,
    device: &DeviceAuthorization,
) -> Result<String, String> {
    // The pi agent waits the poll interval before the first poll.
    wait_before_first_poll(ui, device).await?;
    let mut interval_ms = device.interval_ms;
    let mut slow_down_responses = 0_u32;
    loop {
        if ui.is_cancelled() {
            return Err(LOGIN_CANCELLED.to_string());
        }
        if device
            .deadline
            .is_some_and(|deadline| std::time::Instant::now() >= deadline)
        {
            break;
        }
        let remaining_ms = device.deadline.map_or(REQUEST_TIMEOUT_MS, |deadline| {
            // The remaining deadline (u128 millis) fits u64 comfortably;
            // u64 ms is the request timeout's unit.
            #[allow(clippy::cast_possible_truncation)]
            let remaining = deadline
                .saturating_duration_since(std::time::Instant::now())
                .as_millis() as u64;
            remaining
        });
        let token = post_token_poll(http, ui, &device.device_code, remaining_ms).await?;
        if token.ok {
            if let Some(access_token) = token
                .body
                .get("access_token")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.is_empty())
            {
                return Ok(access_token.to_string());
            }
        }
        match token.body.get("error").and_then(serde_json::Value::as_str) {
            Some("authorization_pending") => {}
            Some("slow_down") => {
                slow_down_responses = slow_down_responses.saturating_add(1);
                // The slow_down bump is a positive wire f64 second count; u64 ms is the poll's unit.
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                let next = token
                    .body
                    .get("interval")
                    .and_then(serde_json::Value::as_f64)
                    .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
                    .map(|seconds| ((seconds * 1000.0) as u64).max(1000));
                interval_ms = match next {
                    Some(next_ms) => next_ms,
                    None => interval_ms.saturating_add(5000).max(1000),
                };
            }
            Some("access_denied") => {
                return Err("Meta login was denied.".to_string());
            }
            Some("expired_token") => {
                return Err("Meta device authorization expired. Please restart login.".to_string());
            }
            _ => {
                // An inline access token on a non-2xx frame still completes the flow.
                if let Some(access_token) = token
                    .body
                    .get("access_token")
                    .and_then(serde_json::Value::as_str)
                    .filter(|value| !value.is_empty())
                {
                    return Ok(access_token.to_string());
                }
                return Err(format!(
                    "Meta device token request failed with status {}{}",
                    token.status,
                    error_detail(&token.body)
                ));
            }
        }
        let wait_ms = device.deadline.map_or(interval_ms, |deadline| {
            #[allow(clippy::cast_possible_truncation)]
            let remaining = deadline
                .saturating_duration_since(std::time::Instant::now())
                .as_millis() as u64;
            remaining.min(interval_ms)
        });
        cancel_aware_sleep(ui, Duration::from_millis(wait_ms)).await?;
    }
    if slow_down_responses > 0 {
        return Err(SLOW_DOWN_TIMEOUT_MESSAGE.to_string());
    }
    Err(DEVICE_FLOW_TIMEOUT_MESSAGE.to_string())
}

async fn wait_before_first_poll(
    ui: &dyn OAuthLoginUi,
    device: &DeviceAuthorization,
) -> Result<(), String> {
    let wait_ms = device.deadline.map_or(device.interval_ms, |deadline| {
        #[allow(clippy::cast_possible_truncation)]
        let remaining = deadline
            .saturating_duration_since(std::time::Instant::now())
            .as_millis() as u64;
        remaining.min(device.interval_ms)
    });
    cancel_aware_sleep(ui, Duration::from_millis(wait_ms)).await
}

async fn post_token_poll(
    http: &dyn ProviderHttp,
    ui: &dyn OAuthLoginUi,
    device_code: &str,
    timeout_ms: u64,
) -> Result<MetaResponse, String> {
    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("grant_type", "urn:ietf:params:oauth:grant-type:device_code")
        .append_pair("device_code", device_code)
        .append_pair("client_id", META_CLIENT_ID)
        .finish();
    request(
        http,
        ui,
        ProviderHttpRequest {
            method: ProviderHttpMethod::Post,
            url: DEVICE_TOKEN_URL.to_string(),
            headers: vec![
                ("Accept".to_string(), "application/json".to_string()),
                (
                    "Content-Type".to_string(),
                    "application/x-www-form-urlencoded".to_string(),
                ),
            ],
            body: Some(body),
            follow_redirects: false,
        },
        timeout_ms.min(REQUEST_TIMEOUT_MS),
        "Meta OAuth request failed. Check your connection and try again.",
    )
    .await
}

async fn mint_api_key(
    http: &dyn ProviderHttp,
    ui: &dyn OAuthLoginUi,
    identity_token: &str,
    timeout_ms: u64,
) -> Result<MetaCredentials, String> {
    if ui.is_cancelled() {
        return Err(LOGIN_CANCELLED.to_string());
    }
    let response = request(
        http,
        ui,
        ProviderHttpRequest {
            method: ProviderHttpMethod::Post,
            url: API_KEY_MINT_URL.to_string(),
            headers: vec![
                ("Accept".to_string(), "application/json".to_string()),
                (
                    "Authorization".to_string(),
                    format!("Bearer {identity_token}"),
                ),
                ("Content-Type".to_string(), "application/json".to_string()),
                ("x-api-version".to_string(), "1.0.0".to_string()),
            ],
            body: Some("{}".to_string()),
            follow_redirects: false,
        },
        timeout_ms.min(REQUEST_TIMEOUT_MS),
        "Meta OAuth request failed. Check your connection and try again.",
    )
    .await?;
    if response.status == 401 || response.status == 403 {
        return Err(format!(
            "Meta session expired (status {}). Run `/login meta` to sign in again.{}",
            response.status,
            error_detail(&response.body)
        ));
    }
    if !response.ok {
        return Err(format!(
            "Meta API key mint failed with status {}{}",
            response.status,
            error_detail(&response.body)
        ));
    }
    let api_key = response
        .body
        .get("api_key")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let Some(api_key) = api_key else {
        let action_suffix = response
            .body
            .get("action_url")
            .and_then(serde_json::Value::as_str)
            .and_then(|raw| verification_uri(raw).ok())
            .map_or_else(String::new, |url| format!(" Complete setup at {url}"));
        return Err(format!("Meta did not issue an API key.{action_suffix}"));
    };
    Ok(MetaCredentials {
        access: api_key,
        refresh: identity_token.to_string(),
        // Saturating: the wall clock plus one day fits i64 for ~292 million years.
        expires: now_ms().saturating_add(API_KEY_LIFETIME_MS),
    })
}

async fn request(
    http: &dyn ProviderHttp,
    ui: &dyn OAuthLoginUi,
    request: ProviderHttpRequest,
    timeout_ms: u64,
    transport_message: &str,
) -> Result<MetaResponse, String> {
    if ui.is_cancelled() {
        return Err(LOGIN_CANCELLED.to_string());
    }
    let response = http.request(request, timeout_ms).await.map_err(|message| {
        if message.contains("timed out") {
            "Meta OAuth request timed out. Try signing in again.".to_string()
        } else {
            transport_message.to_string()
        }
    })?;
    if ui.is_cancelled() {
        return Err(LOGIN_CANCELLED.to_string());
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&response.body).unwrap_or(serde_json::Value::Null);
    let body = match parsed {
        serde_json::Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };
    Ok(MetaResponse {
        ok: response.ok(),
        status: response.status,
        body,
    })
}

/// The pi agent's `errorDetail`: the first non-blank wire message.
fn error_detail(body: &serde_json::Map<String, serde_json::Value>) -> String {
    for key in ["error_description", "detail", "message", "error"] {
        if let Some(detail) = body.get(key).and_then(serde_json::Value::as_str) {
            let detail = detail.trim();
            if !detail.is_empty() {
                return format!(": {detail}");
            }
        }
    }
    String::new()
}

/// A parsed https URL without credentials or control characters.
fn verification_uri(raw: &str) -> Result<String, String> {
    let url = Url::parse(raw)
        .map_err(|_| "Untrusted verification URI in Meta OAuth response".to_string())?;
    let untrusted = url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || raw
            .chars()
            .any(|c| c <= '\u{20}' || ('\u{7f}'..='\u{9f}').contains(&c));
    if untrusted {
        return Err("Untrusted verification URI in Meta OAuth response".to_string());
    }
    Ok(url.to_string())
}

/// The cooperative cancel flag ends the wait mid-sleep.
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

// Epoch millis fit i64 for ~292 million years.
#[allow(clippy::cast_possible_truncation)]
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(i64::MAX, |elapsed| elapsed.as_millis() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, VecDeque};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    type ScriptedResponse = super::super::provider_http::ProviderHttpResponse;

    /// Queued responses per url (popped in order).
    struct ScriptedHttp {
        queued: Mutex<HashMap<String, VecDeque<ScriptedResponse>>>,
        requests: Mutex<Vec<ProviderHttpRequest>>,
    }

    impl ScriptedHttp {
        fn new() -> Self {
            ScriptedHttp {
                queued: Mutex::new(HashMap::new()),
                requests: Mutex::new(Vec::new()),
            }
        }

        fn entry(status: u16, body: &str) -> ScriptedResponse {
            ScriptedResponse {
                status,
                body: body.to_string(),
            }
        }

        fn queue(self, url: &str, responses: Vec<ScriptedResponse>) -> Self {
            self.queued.lock().unwrap().insert(
                url.to_string(),
                responses.into_iter().collect::<VecDeque<_>>(),
            );
            self
        }

        fn bodies_for(&self, url: &str) -> Vec<ProviderHttpRequest> {
            self.requests
                .lock()
                .unwrap()
                .iter()
                .filter(|request| request.url == url)
                .cloned()
                .collect()
        }
    }

    impl ProviderHttp for ScriptedHttp {
        fn request(
            &self,
            request: ProviderHttpRequest,
            _timeout_ms: u64,
        ) -> Pin<Box<dyn Future<Output = Result<ScriptedResponse, String>> + Send + '_>> {
            self.requests.lock().unwrap().push(request.clone());
            let response = self
                .queued
                .lock()
                .unwrap()
                .get_mut(&request.url)
                .and_then(std::collections::VecDeque::pop_front);
            Box::pin(
                async move { response.ok_or_else(|| format!("{} was not scripted", request.url)) },
            )
        }
    }

    struct ScriptedUi {
        auth_url: Mutex<Option<String>>,
        auth_instructions: Mutex<Option<String>>,
        progress: Mutex<Vec<String>>,
        cancelled: Arc<AtomicBool>,
    }

    impl ScriptedUi {
        fn new() -> Self {
            ScriptedUi {
                auth_url: Mutex::new(None),
                auth_instructions: Mutex::new(None),
                progress: Mutex::new(Vec::new()),
                cancelled: Arc::new(AtomicBool::new(false)),
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
            _prompt: &super::super::types::OAuthPrompt,
        ) -> Pin<Box<dyn Future<Output = Option<String>> + Send + '_>> {
            Box::pin(std::future::pending())
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

    /// The device authorization response (a fast poll: interval 0).
    fn device_response() -> ScriptedResponse {
        ScriptedHttp::entry(
            200,
            r#"{"device_code":"dev-1","user_code":"ABCD-1234","verification_uri_complete":"https://auth.meta.com/oidc/device?user_code=ABCD-1234","interval":0,"expires_in":900}"#,
        )
    }

    fn happy_http() -> ScriptedHttp {
        ScriptedHttp::new()
            .queue(DEVICE_AUTHORIZATION_URL, vec![device_response()])
            .queue(
                DEVICE_TOKEN_URL,
                vec![
                    ScriptedHttp::entry(400, r#"{"error":"authorization_pending"}"#),
                    ScriptedHttp::entry(200, r#"{"access_token":"meta-identity"}"#),
                ],
            )
            .queue(
                API_KEY_MINT_URL,
                vec![ScriptedHttp::entry(200, r#"{"api_key":"meta-key-1"}"#)],
            )
    }

    #[tokio::test]
    async fn the_happy_flow_mints_the_model_api_key() {
        let http = happy_http();
        let ui = ScriptedUi::new();
        // Epoch millis fit i64; the assertion's tolerance covers the cast convention.
        #[allow(clippy::cast_possible_truncation)]
        let before = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let credentials = login_meta(&http, &ui).await.unwrap();
        assert_eq!(credentials.access, "meta-key-1");
        assert_eq!(credentials.refresh, "meta-identity");
        #[allow(clippy::cast_possible_truncation)]
        let after = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        assert!(
            credentials.expires >= before + API_KEY_LIFETIME_MS
                && credentials.expires <= after + API_KEY_LIFETIME_MS,
            "the expiry lands one day out: {} vs {before}..{after}",
            credentials.expires
        );
        let device = &http.bodies_for(DEVICE_AUTHORIZATION_URL)[0];
        let body = device.body.as_deref().unwrap();
        assert!(body.contains("client_id=1031625952748946"), "{body}");
        let poll = &http.bodies_for(DEVICE_TOKEN_URL)[1];
        let body = poll.body.as_deref().unwrap();
        assert!(body.contains("device_code=dev-1"), "{body}");
        assert!(
            body.contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code"),
            "{body}"
        );
        let mint = &http.bodies_for(API_KEY_MINT_URL)[0];
        assert_eq!(mint.body.as_deref(), Some("{}"));
        assert!(
            mint.headers
                .iter()
                .any(|(name, value)| name == "Authorization" && value == "Bearer meta-identity"),
            "{:?}",
            mint.headers
        );
        assert!(
            mint.headers
                .iter()
                .any(|(name, value)| name == "x-api-version" && value == "1.0.0"),
            "{:?}",
            mint.headers
        );
        let (url, instructions) = ui.captured_auth();
        assert_eq!(url, "https://auth.meta.com/oidc/device?user_code=ABCD-1234");
        assert_eq!(instructions.as_deref(), Some("Enter code: ABCD-1234"));
        assert_eq!(
            ui.progress.lock().unwrap().as_slice(),
            ["Enabling Meta Model API access..."]
        );
    }

    #[tokio::test]
    async fn the_verification_uri_falls_back_to_the_plain_field() {
        let http = ScriptedHttp::new()
            .queue(
                DEVICE_AUTHORIZATION_URL,
                vec![ScriptedHttp::entry(
                    200,
                    r#"{"device_code":"dev-1","user_code":"CODE-1","verification_uri":"https://auth.meta.com/oidc/device","interval":0,"expires_in":900}"#,
                )],
            )
            .queue(
                DEVICE_TOKEN_URL,
                vec![ScriptedHttp::entry(200, r#"{"access_token":"meta-identity"}"#)],
            )
            .queue(
                API_KEY_MINT_URL,
                vec![ScriptedHttp::entry(200, r#"{"api_key":"meta-key-1"}"#)],
            );
        let ui = ScriptedUi::new();
        login_meta(&http, &ui).await.unwrap();
        let (url, _) = ui.captured_auth();
        assert_eq!(url, "https://auth.meta.com/oidc/device");
    }

    #[tokio::test]
    async fn the_happy_flow_survives_a_slow_down_bump() {
        let http = ScriptedHttp::new()
            .queue(DEVICE_AUTHORIZATION_URL, vec![device_response()])
            .queue(
                DEVICE_TOKEN_URL,
                vec![
                    ScriptedHttp::entry(400, r#"{"error":"slow_down","interval":0}"#),
                    ScriptedHttp::entry(200, r#"{"access_token":"meta-identity"}"#),
                ],
            )
            .queue(
                API_KEY_MINT_URL,
                vec![ScriptedHttp::entry(200, r#"{"api_key":"meta-key-1"}"#)],
            );
        let credentials = login_meta(&http, &ScriptedUi::new()).await.unwrap();
        assert_eq!(credentials.access, "meta-key-1");
    }

    #[tokio::test]
    async fn a_denied_authorization_surfaces_the_pi_message() {
        let http = ScriptedHttp::new()
            .queue(DEVICE_AUTHORIZATION_URL, vec![device_response()])
            .queue(
                DEVICE_TOKEN_URL,
                vec![ScriptedHttp::entry(400, r#"{"error":"access_denied"}"#)],
            );
        let error = login_meta(&http, &ScriptedUi::new()).await.unwrap_err();
        assert_eq!(error, "Meta login was denied.");
    }

    #[tokio::test]
    async fn an_expired_device_code_surfaces_the_pi_message() {
        let http = ScriptedHttp::new()
            .queue(DEVICE_AUTHORIZATION_URL, vec![device_response()])
            .queue(
                DEVICE_TOKEN_URL,
                vec![ScriptedHttp::entry(400, r#"{"error":"expired_token"}"#)],
            );
        let error = login_meta(&http, &ScriptedUi::new()).await.unwrap_err();
        assert_eq!(
            error,
            "Meta device authorization expired. Please restart login."
        );
    }

    #[tokio::test]
    async fn a_failed_poll_surfaces_the_status_line() {
        let http = ScriptedHttp::new()
            .queue(DEVICE_AUTHORIZATION_URL, vec![device_response()])
            .queue(
                DEVICE_TOKEN_URL,
                vec![ScriptedHttp::entry(400, r#"{"error":"bad_request"}"#)],
            );
        let error = login_meta(&http, &ScriptedUi::new()).await.unwrap_err();
        assert_eq!(
            error,
            "Meta device token request failed with status 400: bad_request"
        );
    }

    #[tokio::test]
    async fn a_failed_authorization_surfaces_the_status_line() {
        let http = ScriptedHttp::new().queue(
            DEVICE_AUTHORIZATION_URL,
            vec![ScriptedHttp::entry(
                500,
                r#"{"error_description":"upstream exploded"}"#,
            )],
        );
        let error = login_meta(&http, &ScriptedUi::new()).await.unwrap_err();
        assert_eq!(
            error,
            "Meta device authorization failed with status 500: upstream exploded"
        );
    }

    #[tokio::test]
    async fn a_missing_field_fails_the_authorization_response() {
        let http = ScriptedHttp::new().queue(
            DEVICE_AUTHORIZATION_URL,
            vec![ScriptedHttp::entry(
                200,
                r#"{"device_code":"dev-1","user_code":"CODE-1","interval":0,"expires_in":900}"#,
            )],
        );
        let error = login_meta(&http, &ScriptedUi::new()).await.unwrap_err();
        assert!(
            error.starts_with("Invalid Meta device authorization response: "),
            "{error}"
        );
    }

    #[tokio::test]
    async fn an_untrusted_verification_uri_fails_the_flow() {
        let http = ScriptedHttp::new().queue(
            DEVICE_AUTHORIZATION_URL,
            vec![ScriptedHttp::entry(
                200,
                r#"{"device_code":"d","user_code":"CODE-1","verification_uri":"http://auth.meta.com/device","interval":0,"expires_in":900}"#,
            )],
        );
        let error = login_meta(&http, &ScriptedUi::new()).await.unwrap_err();
        assert!(
            error.starts_with("Invalid Meta device authorization response: "),
            "{error}"
        );
    }

    #[tokio::test]
    async fn an_expired_session_surfaces_the_relogin_message() {
        let http = ScriptedHttp::new()
            .queue(DEVICE_AUTHORIZATION_URL, vec![device_response()])
            .queue(
                DEVICE_TOKEN_URL,
                vec![ScriptedHttp::entry(
                    200,
                    r#"{"access_token":"meta-identity"}"#,
                )],
            )
            .queue(API_KEY_MINT_URL, vec![ScriptedHttp::entry(401, "{}")]);
        let error = login_meta(&http, &ScriptedUi::new()).await.unwrap_err();
        assert_eq!(
            error,
            "Meta session expired (status 401). Run `/login meta` to sign in again."
        );
    }

    #[tokio::test]
    async fn a_missing_api_key_surfaces_the_action_url() {
        let http = ScriptedHttp::new()
            .queue(DEVICE_AUTHORIZATION_URL, vec![device_response()])
            .queue(
                DEVICE_TOKEN_URL,
                vec![ScriptedHttp::entry(
                    200,
                    r#"{"access_token":"meta-identity"}"#,
                )],
            )
            .queue(
                API_KEY_MINT_URL,
                vec![ScriptedHttp::entry(
                    200,
                    r#"{"action_url":"https://auth.meta.com/setup"}"#,
                )],
            );
        let error = login_meta(&http, &ScriptedUi::new()).await.unwrap_err();
        assert_eq!(
            error,
            "Meta did not issue an API key. Complete setup at https://auth.meta.com/setup"
        );
    }

    #[tokio::test]
    async fn the_refresh_mints_a_fresh_key() {
        let http = ScriptedHttp::new().queue(
            API_KEY_MINT_URL,
            vec![ScriptedHttp::entry(200, r#"{"api_key":"meta-key-2"}"#)],
        );
        let credentials = refresh_meta_token(&http, "meta-identity").await.unwrap();
        assert_eq!(credentials.access, "meta-key-2");
        assert_eq!(credentials.refresh, "meta-identity");
        let mint = &http.bodies_for(API_KEY_MINT_URL)[0];
        assert!(
            mint.headers
                .iter()
                .any(|(name, value)| name == "Authorization" && value == "Bearer meta-identity"),
            "{:?}",
            mint.headers
        );
    }

    #[tokio::test]
    async fn a_failed_refresh_surfaces_the_status_line() {
        let http = ScriptedHttp::new().queue(
            API_KEY_MINT_URL,
            vec![ScriptedHttp::entry(500, r#"{"message":"mint exploded"}"#)],
        );
        let error = refresh_meta_token(&http, "meta-identity")
            .await
            .unwrap_err();
        assert_eq!(
            error,
            "Meta API key mint failed with status 500: mint exploded"
        );
    }

    #[tokio::test]
    async fn the_device_code_expires_after_the_deadline() {
        let fast_expiry = serde_json::json!({
            "device_code": "dev-1",
            "user_code": "CODE-1",
            "verification_uri": "https://auth.meta.com/device",
            "interval": 0,
            "expires_in": 1,
        });
        let http = ScriptedHttp::new()
            .queue(
                DEVICE_AUTHORIZATION_URL,
                vec![ScriptedResponse {
                    status: 200,
                    body: fast_expiry.to_string(),
                }],
            )
            .queue(
                DEVICE_TOKEN_URL,
                vec![ScriptedHttp::entry(
                    400,
                    r#"{"error":"authorization_pending"}"#,
                )],
            );
        let error = tokio::time::timeout(
            Duration::from_secs(5),
            login_meta(&http, &ScriptedUi::new()),
        )
        .await
        .expect("the expired deadline settles")
        .unwrap_err();
        assert_eq!(error, DEVICE_FLOW_TIMEOUT_MESSAGE);
    }

    #[tokio::test]
    async fn a_cancelled_surface_ends_the_poll_between_waits() {
        let http = ScriptedHttp::new()
            .queue(DEVICE_AUTHORIZATION_URL, vec![device_response()])
            .queue(
                DEVICE_TOKEN_URL,
                vec![ScriptedHttp::entry(
                    400,
                    r#"{"error":"authorization_pending"}"#,
                )],
            );
        let ui = Arc::new(ScriptedUi::new());
        let flow = {
            let flow_http = Arc::new(http);
            let flow_ui = Arc::clone(&ui);
            tokio::spawn(async move { login_meta(flow_http.as_ref(), flow_ui.as_ref()).await })
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while ui.auth_url.lock().unwrap().is_none() {
            assert!(
                std::time::Instant::now() < deadline,
                "the flow never presented its url"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        ui.cancelled.store(true, Ordering::Relaxed);
        let error = tokio::time::timeout(Duration::from_secs(10), flow)
            .await
            .expect("the cancelled poll settles promptly")
            .unwrap()
            .unwrap_err();
        assert_eq!(error, LOGIN_CANCELLED);
    }

    #[tokio::test]
    async fn an_unreachable_endpoint_surfaces_the_transport_error() {
        let http = ScriptedHttp::new();
        let error = login_meta(&http, &ScriptedUi::new()).await.unwrap_err();
        assert_eq!(
            error,
            "Meta OAuth request failed. Check your connection and try again."
        );
    }
}
