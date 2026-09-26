//! The xAI (Grok) OAuth flow — the port of
//! `packages/ai/src/utils/oauth/xai.ts`: the device-code flow against
//! the xAI auth endpoints with strict response validation (a
//! https-only verification URI, validated field types, the bounded
//! `expires_in`), the `slow_down` backoff, and the token refresh that
//! keeps the prior refresh token when the endpoint omits one. The
//! credentials the flow returns carry the TS shape (`access`,
//! `refresh`, `expires`) and persist under the provider id `xai`.
//!
//! Cancellation follows the fleet's cooperative pattern (#2770): the
//! driving surface marks a shared flag when it exits; the poll loop
//! checks it between its wait steps and the request wrapper checks it
//! around every network step.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use url::Url;

use super::provider_http::{ProviderHttp, ProviderHttpMethod, ProviderHttpRequest};
use super::types::OAuthLoginUi;

/// The app registration the TS flow ships (TS `CLIENT_ID`).
pub const XAI_CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
/// TS `SCOPE`.
const SCOPE: &str = "openid profile email offline_access grok-cli:access api:access";
/// TS `DEVICE_CODE_URL`.
const DEVICE_CODE_URL: &str = "https://auth.x.ai/oauth2/device/code";
/// TS `TOKEN_URL`.
const TOKEN_URL: &str = "https://auth.x.ai/oauth2/token";
/// TS `REQUEST_TIMEOUT_MS` (the per-request bound).
pub const REQUEST_TIMEOUT_MS: u64 = 30_000;
/// TS `REFRESH_SKEW_MS` (the credential's expiry skew, capped at half
/// the token's lifetime).
const REFRESH_SKEW_MS: i64 = 5 * 60 * 1000;
/// The device poll's default interval (TS: 5000 when the response
/// carries none).
const DEFAULT_POLL_INTERVAL_MS: u64 = 5000;
/// The refresh grant's request bound: the refresh runs under the auth
/// store's file lock, which a peer declares stale after 10 seconds — the
/// request must fit inside that window so a slow endpoint fails the
/// refresh (kept for a retry) instead of holding the lock past its
/// staleness.
pub const REFRESH_TIMEOUT_MS: u64 = 8_000;
/// The cancel error the driving surface maps to the silent cancelled
/// outcome.
pub const LOGIN_CANCELLED: &str = "Login cancelled";
/// The poll's cancel-check step (#2770).
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// The credentials the flow returns and persist (TS
/// `OAuthCredentials` for the xAI provider).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XaiCredentials {
    pub access: String,
    pub refresh: String,
    /// Wall-clock epoch milliseconds (TS `Date.now() + lifetime -
    /// min(REFRESH_SKEW_MS, lifetime / 2)`).
    pub expires: i64,
}

/// One endpoint response (TS `OAuthResponse`: the status plus the
/// parsed object — an empty object when the body is not one).
struct XaiResponse {
    ok: bool,
    status: u16,
    body: serde_json::Map<String, serde_json::Value>,
}

/// Run the login (TS `loginXai`): the device authorization, the user
/// code, and the token poll with the TS backoff and the strict
/// validation.
///
/// # Errors
///
/// Returns an error when the surface cancelled the login
/// ([`LOGIN_CANCELLED`]), the device authorization fails, the device
/// code expires, the authorization is denied, or a token response
/// fails validation.
pub async fn login_xai(
    http: &dyn ProviderHttp,
    ui: &dyn OAuthLoginUi,
) -> Result<XaiCredentials, String> {
    // An exited surface never starts: no device request, no browser
    // launch (the #2770 flag is the seam).
    if ui.is_cancelled() {
        return Err(LOGIN_CANCELLED.to_string());
    }
    let response = post_form(
        http,
        ui,
        DEVICE_CODE_URL,
        &[
            ("client_id", XAI_CLIENT_ID),
            ("scope", SCOPE),
            ("referrer", "pi"),
        ],
        REQUEST_TIMEOUT_MS,
    )
    .await?;
    if !response.ok {
        return Err(request_failure("device authorization", &response));
    }
    let device_code = required_string(&response.body, "device_code")?;
    let user_code = required_string(&response.body, "user_code")?;
    if user_code.is_empty()
        || !user_code
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("Invalid xAI OAuth response field: user_code".to_string());
    }
    let verification_uri_raw = required_string(&response.body, "verification_uri")?;
    let url = verification_uri(&verification_uri_raw)?;
    let expires_in = positive_seconds(response.body.get("expires_in"))?;
    let deadline = std::time::Instant::now() + Duration::from_secs(expires_in as u64);
    let mut interval_ms = response
        .body
        .get("interval")
        .and_then(serde_json::Value::as_f64)
        .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
        .map_or(DEFAULT_POLL_INTERVAL_MS, |seconds| {
            ((seconds * 1000.0) as u64).max(1000)
        });
    ui.on_auth(&url, Some(&format!("Enter code: {user_code}")));

    while std::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        cancel_aware_sleep(ui, remaining.min(Duration::from_millis(interval_ms))).await?;
        if std::time::Instant::now() >= deadline {
            break;
        }
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        let token = post_form(
            http,
            ui,
            TOKEN_URL,
            &[
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("client_id", XAI_CLIENT_ID),
                ("device_code", device_code.as_str()),
            ],
            remaining.as_millis() as u64,
        )
        .await?;
        if token.ok {
            return credentials_from_response(&token.body, None);
        }
        match token.body.get("error").and_then(serde_json::Value::as_str) {
            Some("authorization_pending") => {}
            Some("slow_down") => {
                let next = token
                    .body
                    .get("interval")
                    .and_then(serde_json::Value::as_f64)
                    .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
                    .map(|seconds| (seconds * 1000.0) as u64);
                interval_ms = match next {
                    Some(next_ms) => (interval_ms + 5000).max(next_ms),
                    None => interval_ms + 5000,
                };
            }
            Some("access_denied" | "authorization_denied") => {
                return Err("xAI device authorization was denied".to_string());
            }
            Some("expired_token") => {
                return Err("xAI device code expired; sign in again".to_string());
            }
            _ => return Err(request_failure("device token polling", &token)),
        }
    }
    Err("xAI device code expired; sign in again".to_string())
}

/// Refresh an expired credential (TS `refreshXaiToken`).
///
/// # Errors
///
/// Returns an error when the token refresh fails.
pub async fn refresh_xai_token(
    http: &dyn ProviderHttp,
    refresh_token: &str,
) -> Result<XaiCredentials, String> {
    let response = post_form(
        http,
        &NoCancel,
        TOKEN_URL,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", XAI_CLIENT_ID),
            ("refresh_token", refresh_token),
        ],
        REFRESH_TIMEOUT_MS,
    )
    .await?;
    if !response.ok {
        return Err(request_failure("token refresh", &response));
    }
    credentials_from_response(&response.body, Some(refresh_token))
}

/// A surface that never cancels (the refresh runs detached from any
/// interactive surface).
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

/// TS `postForm`: the form POST with the TS error taxonomy — the
/// cancelled surface, the timeout, the failed request, and the
/// invalid-JSON status line.
async fn post_form(
    http: &dyn ProviderHttp,
    ui: &dyn OAuthLoginUi,
    url: &str,
    fields: &[(&str, &str)],
    timeout_ms: u64,
) -> Result<XaiResponse, String> {
    if ui.is_cancelled() {
        return Err(LOGIN_CANCELLED.to_string());
    }
    let body = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(fields.iter().map(|(key, value)| (*key, *value)))
        .finish();
    let response = http
        .request(
            ProviderHttpRequest {
                method: ProviderHttpMethod::Post,
                url: url.to_string(),
                headers: vec![
                    ("Accept".to_string(), "application/json".to_string()),
                    (
                        "Content-Type".to_string(),
                        "application/x-www-form-urlencoded".to_string(),
                    ),
                ],
                body: Some(body),
                // TS `redirect: "error"`: a redirected request fails.
                follow_redirects: false,
            },
            timeout_ms.min(REQUEST_TIMEOUT_MS),
        )
        .await
        .map_err(|message| {
            if message.contains("timed out") {
                "xAI OAuth request timed out. Try signing in again.".to_string()
            } else {
                "xAI OAuth request failed. Check your connection and try again.".to_string()
            }
        })?;
    if ui.is_cancelled() {
        return Err(LOGIN_CANCELLED.to_string());
    }
    let parsed: serde_json::Value = serde_json::from_str(&response.body)
        .map_err(|_| format!("xAI OAuth returned invalid JSON (HTTP {})", response.status))?;
    let body = match parsed {
        serde_json::Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };
    Ok(XaiResponse {
        ok: response.ok(),
        status: response.status,
        body,
    })
}

/// TS `requestFailure`: the action's status line; the
/// `invalid_grant` suffix names the expired-or-revoked cause.
fn request_failure(action: &str, response: &XaiResponse) -> String {
    let suffix = if response
        .body
        .get("error")
        .and_then(serde_json::Value::as_str)
        == Some("invalid_grant")
    {
        ": authorization expired or revoked; sign in again"
    } else {
        ""
    };
    format!(
        "xAI OAuth {action} failed (HTTP {}){suffix}",
        response.status
    )
}

/// TS `credentialsFromResponse`: the validated fields and the expiry
/// arithmetic (`lifetime - min(5 minutes, lifetime / 2)`).
fn credentials_from_response(
    body: &serde_json::Map<String, serde_json::Value>,
    previous_refresh: Option<&str>,
) -> Result<XaiCredentials, String> {
    let access = required_string(body, "access_token")?;
    let refresh = match body.get("refresh_token") {
        None => previous_refresh
            .map(str::to_string)
            .ok_or_else(|| "Invalid xAI OAuth response field: refresh_token".to_string())?,
        Some(value) => value
            .as_str()
            .filter(|token| !token.trim().is_empty())
            .map(str::to_string)
            .ok_or_else(|| "Invalid xAI OAuth response field: refresh_token".to_string())?,
    };
    let lifetime_ms = positive_seconds(body.get("expires_in").or(Some(&serde_json::json!(3600))))?
        .saturating_mul(1000);
    Ok(XaiCredentials {
        access,
        refresh,
        // Saturating: a hostile `expires_in` must not overflow the sum
        // (the NaN/inf gate already answered the field error).
        expires: now_ms()
            .saturating_add(lifetime_ms)
            .saturating_sub(REFRESH_SKEW_MS.min(lifetime_ms / 2)),
    })
}

/// TS `requiredString`.
fn required_string(
    body: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<String, String> {
    body.get(field)
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("Invalid xAI OAuth response field: {field}"))
}

/// TS `positiveSeconds` (the field's own name rides the error).
fn positive_seconds(value: Option<&serde_json::Value>) -> Result<i64, String> {
    let seconds = value
        .and_then(serde_json::Value::as_f64)
        .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
        .ok_or_else(|| "Invalid xAI OAuth response field: expires_in".to_string())?;
    Ok(seconds as i64)
}

/// TS `verificationUri`: a parsed https URL without credentials or
/// control characters.
fn verification_uri(raw: &str) -> Result<String, String> {
    let url = Url::parse(raw)
        .map_err(|_| "Untrusted verification URI in xAI OAuth response".to_string())?;
    let untrusted = |url: &Url| -> bool {
        url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || raw
                .chars()
                .any(|c| c <= '\u{20}' || ('\u{7f}'..='\u{9f}').contains(&c))
    };
    if untrusted(&url) {
        return Err("Untrusted verification URI in xAI OAuth response".to_string());
    }
    Ok(url.to_string())
}

/// One abortable wait (TS `wait`): the cooperative cancel ends it
/// mid-wait instead of the abort signal.
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

/// Wall-clock milliseconds since the epoch (the `expires` convention).
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

    /// A scripted transport: queued responses per url (popped in
    /// order); every request is recorded.
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

    /// The scripted login surface: the captured auth block and the
    /// cancel flag.
    struct ScriptedUi {
        auth_url: Mutex<Option<String>>,
        auth_instructions: Mutex<Option<String>>,
        cancelled: Arc<AtomicBool>,
        cancel_on_auth: bool,
    }

    impl ScriptedUi {
        fn new() -> Self {
            ScriptedUi {
                auth_url: Mutex::new(None),
                auth_instructions: Mutex::new(None),
                cancelled: Arc::new(AtomicBool::new(false)),
                cancel_on_auth: false,
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
            if self.cancel_on_auth {
                self.cancelled.store(true, Ordering::Relaxed);
            }
        }

        fn on_prompt(
            &self,
            _prompt: &super::super::types::OAuthPrompt,
        ) -> Pin<Box<dyn Future<Output = Option<String>> + Send + '_>> {
            Box::pin(std::future::pending())
        }

        fn on_progress(&self, _message: &str) {}

        fn on_manual_code_input(
            &self,
        ) -> Option<Pin<Box<dyn Future<Output = Option<String>> + Send + '_>>> {
            None
        }

        fn is_cancelled(&self) -> bool {
            self.cancelled.load(Ordering::Relaxed)
        }
    }

    /// The device authorization step's scripted response (a fast poll:
    /// interval 0).
    fn device_response(body: &str) -> ScriptedResponse {
        let json = serde_json::json!({
            "device_code": "dev-1",
            "user_code": "GROK-1234",
            "verification_uri": "https://auth.x.ai/activate",
            "interval": 0,
            "expires_in": 900,
        });
        let _ = body;
        ScriptedResponse {
            status: 200,
            body: json.to_string(),
        }
    }

    #[tokio::test]
    async fn the_happy_flow_resolves_the_credentials() {
        let http = ScriptedHttp::new()
            .queue(DEVICE_CODE_URL, vec![device_response("")])
            .queue(
                TOKEN_URL,
                vec![
                    ScriptedHttp::entry(400, r#"{"error":"authorization_pending"}"#),
                    ScriptedHttp::entry(
                        200,
                        r#"{"access_token":"grok-access","refresh_token":"grok-refresh","expires_in":3600}"#,
                    ),
                ],
            );
        let ui = ScriptedUi::new();
        let credentials = login_xai(&http, &ui).await.unwrap();
        assert_eq!(credentials.access, "grok-access");
        assert_eq!(credentials.refresh, "grok-refresh");
        // TS: expires = now + lifetime - min(5 minutes, lifetime / 2).
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let skew = (credentials.expires - now - (3600 * 1000 - 300_000)).abs();
        assert!(skew < 10_000, "the expiry arithmetic: {skew}");
        // The device request carries the TS body (scope + referrer).
        let device = &http.bodies_for(DEVICE_CODE_URL)[0];
        let body = device.body.as_deref().unwrap();
        assert!(body.contains("client_id=b1a00492-073a-47ea-816f-4c329264a828"));
        assert!(
            body.contains(
                "scope=openid+profile+email+offline_access+grok-cli%3Aaccess+api%3Aaccess"
            ),
            "{body}"
        );
        assert!(body.contains("referrer=pi"));
        // The poll request carries the device-code grant.
        let poll = &http.bodies_for(TOKEN_URL)[1];
        let body = poll.body.as_deref().unwrap();
        assert!(body.contains("device_code=dev-1"));
        assert!(
            body.contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code"),
            "{body}"
        );
        // The auth block: the validated https URI + the user code.
        let (url, instructions) = ui.captured_auth();
        assert_eq!(url, "https://auth.x.ai/activate");
        assert_eq!(instructions.as_deref(), Some("Enter code: GROK-1234"));
    }

    #[tokio::test]
    async fn the_happy_flow_survives_a_slow_down_bump() {
        let http = ScriptedHttp::new()
            .queue(DEVICE_CODE_URL, vec![device_response("")])
            .queue(
                TOKEN_URL,
                vec![
                    ScriptedHttp::entry(400, r#"{"error":"authorization_pending"}"#),
                    ScriptedHttp::entry(400, r#"{"error":"slow_down","interval":0}"#),
                    ScriptedHttp::entry(
                        200,
                        r#"{"access_token":"grok-access","refresh_token":"grok-refresh"}"#,
                    ),
                ],
            );
        let ui = ScriptedUi::new();
        let credentials = login_xai(&http, &ui).await.unwrap();
        // The absent expires_in defaults to one hour (TS 3600).
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let skew = (credentials.expires - now - (3600 * 1000 - 300_000)).abs();
        assert!(skew < 10_000, "the default lifetime: {skew}");
    }

    #[tokio::test]
    async fn a_denied_authorization_surfaces_the_ts_message() {
        let http = ScriptedHttp::new()
            .queue(DEVICE_CODE_URL, vec![device_response("")])
            .queue(
                TOKEN_URL,
                vec![ScriptedHttp::entry(400, r#"{"error":"access_denied"}"#)],
            );
        let ui = ScriptedUi::new();
        let error = login_xai(&http, &ui).await.unwrap_err();
        assert_eq!(error, "xAI device authorization was denied");
    }

    #[tokio::test]
    async fn an_expired_device_code_surfaces_the_ts_message() {
        let http = ScriptedHttp::new()
            .queue(DEVICE_CODE_URL, vec![device_response("")])
            .queue(
                TOKEN_URL,
                vec![ScriptedHttp::entry(400, r#"{"error":"expired_token"}"#)],
            );
        let ui = ScriptedUi::new();
        let error = login_xai(&http, &ui).await.unwrap_err();
        assert_eq!(error, "xAI device code expired; sign in again");
    }

    #[tokio::test]
    async fn an_invalid_user_code_fails_the_field() {
        let http = ScriptedHttp::new().queue(
            DEVICE_CODE_URL,
            vec![ScriptedHttp::entry(
                200,
                r#"{"device_code":"d","user_code":"bad code!","verification_uri":"https://auth.x.ai/a","interval":0,"expires_in":900}"#,
            )],
        );
        let ui = ScriptedUi::new();
        let error = login_xai(&http, &ui).await.unwrap_err();
        assert_eq!(error, "Invalid xAI OAuth response field: user_code");
    }

    #[tokio::test]
    async fn an_untrusted_verification_uri_fails_the_flow() {
        let http = ScriptedHttp::new().queue(
            DEVICE_CODE_URL,
            vec![ScriptedHttp::entry(
                200,
                r#"{"device_code":"d","user_code":"CODE-1","verification_uri":"http://auth.x.ai/activate","interval":0,"expires_in":900}"#,
            )],
        );
        let ui = ScriptedUi::new();
        let error = login_xai(&http, &ui).await.unwrap_err();
        assert_eq!(error, "Untrusted verification URI in xAI OAuth response");
        // A URL with credentials is untrusted too.
        let http = ScriptedHttp::new().queue(
            DEVICE_CODE_URL,
            vec![ScriptedHttp::entry(
                200,
                r#"{"device_code":"d","user_code":"CODE-1","verification_uri":"https://user:pw@auth.x.ai/activate","interval":0,"expires_in":900}"#,
            )],
        );
        let error = login_xai(&http, &ScriptedUi::new()).await.unwrap_err();
        assert_eq!(error, "Untrusted verification URI in xAI OAuth response");
    }

    #[tokio::test]
    async fn an_invalid_json_body_surfaces_the_status_line() {
        let http = ScriptedHttp::new().queue(
            DEVICE_CODE_URL,
            vec![ScriptedHttp::entry(200, "<html>gateway error</html>")],
        );
        let ui = ScriptedUi::new();
        let error = login_xai(&http, &ui).await.unwrap_err();
        assert_eq!(error, "xAI OAuth returned invalid JSON (HTTP 200)");
    }

    #[tokio::test]
    async fn a_failed_authorization_surfaces_the_status_line() {
        let http = ScriptedHttp::new().queue(
            DEVICE_CODE_URL,
            vec![ScriptedHttp::entry(400, r#"{"error":"bad_request"}"#)],
        );
        let ui = ScriptedUi::new();
        let error = login_xai(&http, &ui).await.unwrap_err();
        assert_eq!(error, "xAI OAuth device authorization failed (HTTP 400)");
    }

    #[tokio::test]
    async fn an_unreachable_endpoint_surfaces_the_ts_transport_error() {
        // Nothing scripted: the transport fails the request.
        let http = ScriptedHttp::new();
        let ui = ScriptedUi::new();
        let error = login_xai(&http, &ui).await.unwrap_err();
        assert_eq!(
            error,
            "xAI OAuth request failed. Check your connection and try again."
        );
    }

    #[tokio::test]
    async fn a_cancelled_surface_ends_the_poll_between_waits() {
        let http = ScriptedHttp::new()
            .queue(DEVICE_CODE_URL, vec![device_response("")])
            .queue(
                TOKEN_URL,
                vec![ScriptedHttp::entry(
                    400,
                    r#"{"error":"authorization_pending"}"#,
                )],
            );
        let ui = Arc::new(ScriptedUi::new());
        let flow = {
            let flow_http = Arc::new(http);
            let flow_ui = Arc::clone(&ui);
            tokio::spawn(async move { login_xai(flow_http.as_ref(), flow_ui.as_ref()).await })
        };
        // Readiness-wait for the URL (bounded: a missing URL fails the
        // test instead of hanging the cancel flip).
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
    async fn the_device_code_expires_after_the_deadline() {
        let fast_expiry = serde_json::json!({
            "device_code": "dev-1",
            "user_code": "CODE-1",
            "verification_uri": "https://auth.x.ai/activate",
            "interval": 0,
            "expires_in": 1,
        });
        let http = ScriptedHttp::new()
            .queue(
                DEVICE_CODE_URL,
                vec![ScriptedResponse {
                    status: 200,
                    body: fast_expiry.to_string(),
                }],
            )
            .queue(
                TOKEN_URL,
                vec![ScriptedHttp::entry(
                    400,
                    r#"{"error":"authorization_pending"}"#,
                )],
            );
        let ui = ScriptedUi::new();
        let error = tokio::time::timeout(Duration::from_secs(5), login_xai(&http, &ui))
            .await
            .expect("the expired deadline settles")
            .unwrap_err();
        assert_eq!(error, "xAI device code expired; sign in again");
    }

    #[tokio::test]
    async fn the_refresh_posts_the_grant_and_keeps_the_prior_token() {
        let http = ScriptedHttp::new().queue(
            TOKEN_URL,
            vec![ScriptedHttp::entry(
                200,
                r#"{"access_token":"grok-fresh","expires_in":600}"#,
            )],
        );
        let credentials = refresh_xai_token(&http, "grok-old").await.unwrap();
        assert_eq!(credentials.access, "grok-fresh");
        // The endpoint omitted a refresh token: the prior one stays.
        assert_eq!(credentials.refresh, "grok-old");
        // The lifetime is capped: min(5 minutes, lifetime / 2) = 300s.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let skew = (credentials.expires - now - (600 * 1000 - 300_000)).abs();
        assert!(skew < 10_000, "the capped skew: {skew}");
        let body = http.bodies_for(TOKEN_URL)[0].body.clone().unwrap();
        assert!(body.contains("grant_type=refresh_token"));
        assert!(body.contains("refresh_token=grok-old"));
    }

    #[tokio::test]
    async fn an_invalid_grant_refresh_names_the_cause() {
        let http = ScriptedHttp::new().queue(
            TOKEN_URL,
            vec![ScriptedHttp::entry(400, r#"{"error":"invalid_grant"}"#)],
        );
        let error = refresh_xai_token(&http, "grok-old").await.unwrap_err();
        assert_eq!(
            error,
            "xAI OAuth token refresh failed (HTTP 400): authorization expired or revoked; sign in again"
        );
    }

    #[tokio::test]
    async fn a_missing_field_token_fails_the_field() {
        // The login path carries no prior refresh token (the refresh
        // path keeps the stored one — TS `credentialsFromResponse`).
        let http = ScriptedHttp::new()
            .queue(DEVICE_CODE_URL, vec![device_response("")])
            .queue(
                TOKEN_URL,
                vec![ScriptedHttp::entry(200, r#"{"access_token":"a"}"#)],
            );
        let error = login_xai(&http, &ScriptedUi::new()).await.unwrap_err();
        assert_eq!(error, "Invalid xAI OAuth response field: refresh_token");
    }

    #[tokio::test]
    async fn a_non_object_json_body_fails_the_fields() {
        let http = ScriptedHttp::new().queue(TOKEN_URL, vec![ScriptedHttp::entry(200, "[1, 2]")]);
        let error = refresh_xai_token(&http, "grok-old").await.unwrap_err();
        assert_eq!(error, "Invalid xAI OAuth response field: access_token");
    }
}
