//! The Anthropic (Claude Pro/Max) OAuth flow: the PKCE request, the
//! localhost callback server raced against the manual paste, the JSON
//! token exchange, and the refresh. The TS flow doubles its PKCE
//! verifier as the OAuth `state` — kept for wire parity.

use std::time::Duration;

use serde_json::json;
use url::Url;

use super::anthropic_callback::{AnthropicCallbackServer, CallbackCode, REDIRECT_URI};
use super::pkce::generate_pkce;
use super::provider_http::{ProviderHttp, ProviderHttpMethod, ProviderHttpRequest};
use super::types::{OAuthLoginUi, OAuthPrompt};

/// TS stores the id base64-encoded; the decoded value is the wire
/// value.
pub const ANTHROPIC_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";
const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const SCOPES: &str = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
pub const DEFAULT_TOKEN_TIMEOUT_MS: u64 = 30_000;
const EXPIRY_SKEW_MS: i64 = 5 * 60 * 1000;
/// The refresh runs under the auth store's file lock, which a peer declares stale after 10 seconds;
/// the request must fit inside that window.
pub const REFRESH_TIMEOUT_MS: u64 = 8_000;
const AUTH_INSTRUCTIONS: &str =
    "Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.";
const PROMPT_MESSAGE: &str = "Paste the authorization code or full redirect URL:";
/// The cancel error the driving surface maps to the silent cancelled outcome.
pub const LOGIN_CANCELLED: &str = "Login cancelled";
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnthropicCredentials {
    pub access: String,
    pub refresh: String,
    /// Wall-clock epoch milliseconds.
    pub expires: i64,
}

/// Race the browser callback against the manual paste, exchange the
/// code, and return the credentials to persist.
///
/// # Errors
///
/// Returns an error when the port cannot be bound, the login is cancelled
/// ([`LOGIN_CANCELLED`]), the paste mismatches, or the exchange fails.
pub async fn login_anthropic(
    http: &dyn ProviderHttp,
    ui: &dyn OAuthLoginUi,
) -> Result<AnthropicCredentials, String> {
    if ui.is_cancelled() {
        return Err(LOGIN_CANCELLED.to_string());
    }
    let (verifier, challenge) = generate_pkce();
    let server = AnthropicCallbackServer::start(&verifier)?;
    login_with_server(http, ui, &server, &verifier, &challenge).await
}

/// The flow after the bind: present the URL, race the callback against
/// the paste, exchange the code. `server` listens with `verifier` as
/// its state.
async fn login_with_server(
    http: &dyn ProviderHttp,
    ui: &dyn OAuthLoginUi,
    server: &AnthropicCallbackServer,
    verifier: &str,
    challenge: &str,
) -> Result<AnthropicCredentials, String> {
    ui.on_auth(
        &authorization_url(challenge, verifier),
        Some(AUTH_INSTRUCTIONS),
    );
    let code = wait_for_code(server, ui, verifier).await?;
    if ui.is_cancelled() {
        return Err(LOGIN_CANCELLED.to_string());
    }
    ui.on_progress("Exchanging authorization code for tokens...");
    exchange_authorization_code(http, &code, verifier).await
}

/// Refresh an expired credential.
///
/// # Errors
///
/// Returns an error when the token refresh fails.
pub async fn refresh_anthropic_token(
    http: &dyn ProviderHttp,
    refresh_token: &str,
) -> Result<AnthropicCredentials, String> {
    let body = json!({
        "grant_type": "refresh_token",
        "client_id": ANTHROPIC_CLIENT_ID,
        "refresh_token": refresh_token,
    })
    .to_string();
    let token = json_token_request(
        http,
        TOKEN_URL,
        &body,
        "Anthropic token refresh",
        REFRESH_TIMEOUT_MS,
        "",
    )
    .await?;
    Ok(credentials_from(token))
}

fn authorization_url(challenge: &str, verifier: &str) -> String {
    let mut url = Url::parse(AUTHORIZE_URL).expect("the authorize url parses");
    for (name, value) in [
        ("code", "true"),
        ("client_id", ANTHROPIC_CLIENT_ID),
        ("response_type", "code"),
        ("redirect_uri", REDIRECT_URI),
        ("scope", SCOPES),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
        ("state", verifier),
    ] {
        url.query_pairs_mut().append_pair(name, value);
    }
    url.to_string()
}

async fn wait_for_code(
    server: &AnthropicCallbackServer,
    ui: &dyn OAuthLoginUi,
    verifier: &str,
) -> Result<CallbackCode, String> {
    let manual = ui.on_manual_code_input();
    let manual_available = manual.is_some();
    let manual_answer = async {
        match manual {
            Some(future) => future.await,
            None => std::future::pending::<Option<String>>().await,
        }
    };
    tokio::pin!(manual_answer);
    // The browser redirect wins over a late manual paste: the manual
    // answer only cancels the server's wait (TS `server.cancelWait`).
    let wait = server.wait_for_code();
    tokio::pin!(wait);
    let mut tick = tokio::time::interval(CANCEL_POLL_INTERVAL);
    let raced = loop {
        if ui.is_cancelled() {
            return Err(LOGIN_CANCELLED.to_string());
        }
        tokio::select! {
            _ = tick.tick() => {}
            code = &mut wait => break RaceOutcome::Callback(code),
            answer = &mut manual_answer => break RaceOutcome::Manual(answer),
        }
    };
    let code: Option<CallbackCode> = match raced {
        RaceOutcome::Callback(Some(code)) => Some(code),
        RaceOutcome::Callback(None) => {
            if manual_available {
                match manual_answer.await {
                    None => return Err(LOGIN_CANCELLED.to_string()),
                    Some(input) => parse_paste(&input, verifier)?,
                }
            } else {
                None
            }
        }
        RaceOutcome::Manual(None) => return Err(LOGIN_CANCELLED.to_string()),
        RaceOutcome::Manual(Some(input)) => parse_paste(&input, verifier)?,
    };
    if let Some(code) = code {
        return Ok(code);
    }
    let answer = ui
        .on_prompt(&OAuthPrompt {
            message: PROMPT_MESSAGE.to_string(),
            placeholder: Some(REDIRECT_URI.to_string()),
            allow_empty: false,
        })
        .await;
    let input = answer.ok_or_else(|| LOGIN_CANCELLED.to_string())?;
    parse_paste(&input, verifier)?.ok_or_else(|| "Missing authorization code".to_string())
}

enum RaceOutcome {
    /// The code, or `None` on a settled-empty wait.
    Callback(Option<CallbackCode>),
    /// The paste input, or `None` when cancelled.
    Manual(Option<String>),
}

fn parse_paste(input: &str, verifier: &str) -> Result<Option<CallbackCode>, String> {
    let (code, echoed) = parse_authorization_input(input);
    if let Some(echoed) = &echoed {
        if echoed != verifier {
            return Err("OAuth state mismatch".to_string());
        }
    }
    Ok(code.map(|code| CallbackCode {
        code,
        state: echoed.unwrap_or_else(|| verifier.to_string()),
    }))
}

fn parse_authorization_input(input: &str) -> (Option<String>, Option<String>) {
    let value = input.trim();
    if value.is_empty() {
        return (None, None);
    }
    let non_empty = |value: Option<String>| value.filter(|value| !value.is_empty());
    if let Ok(url) = Url::parse(value) {
        let get = |name: &str| {
            non_empty(
                url.query_pairs()
                    .find(|(key, _)| key == name)
                    .map(|(_, value)| value.to_string()),
            )
        };
        return (get("code"), get("state"));
    }
    if value.contains('#') {
        let mut parts = value.splitn(2, '#');
        let code = parts.next().unwrap_or_default();
        let state = parts.next().unwrap_or_default();
        return (
            non_empty(Some(code.to_string())),
            non_empty(Some(state.to_string())),
        );
    }
    if value.contains("code=") {
        let get = |name: &str| {
            non_empty(
                url::form_urlencoded::parse(value.as_bytes())
                    .find(|(key, _)| key == name)
                    .map(|(_, value)| value.to_string()),
            )
        };
        return (get("code"), get("state"));
    }
    (non_empty(Some(value.to_string())), None)
}

struct TokenResponse {
    access: String,
    refresh: String,
    expires_in: i64,
}

fn credentials_from(token: TokenResponse) -> AnthropicCredentials {
    // Saturating: a hostile `expires_in` must not overflow the sum.
    AnthropicCredentials {
        access: token.access,
        refresh: token.refresh,
        expires: now_ms()
            .saturating_add(token.expires_in.saturating_mul(1000))
            .saturating_sub(EXPIRY_SKEW_MS),
    }
}

// Epoch millis fit i64 for ~292 million years.
#[allow(clippy::cast_possible_truncation)]
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(i64::MAX, |elapsed| elapsed.as_millis() as i64)
}

async fn exchange_authorization_code(
    http: &dyn ProviderHttp,
    code: &CallbackCode,
    verifier: &str,
) -> Result<AnthropicCredentials, String> {
    let body = json!({
        "grant_type": "authorization_code",
        "client_id": ANTHROPIC_CLIENT_ID,
        "code": code.code,
        "state": code.state,
        "redirect_uri": REDIRECT_URI,
        "code_verifier": verifier,
    })
    .to_string();
    let token = json_token_request(
        http,
        TOKEN_URL,
        &body,
        "Token exchange",
        DEFAULT_TOKEN_TIMEOUT_MS,
        &format!(" redirect_uri={REDIRECT_URI}; response_type=authorization_code;"),
    )
    .await?;
    Ok(credentials_from(token))
}

/// One JSON token POST through the TS error wrappers (`Error: <message>` heads). A missing field is
/// this port's explicit error where TS would persist an unusable credential.
async fn json_token_request(
    http: &dyn ProviderHttp,
    url: &str,
    body: &str,
    label: &str,
    timeout_ms: u64,
    wire_context: &str,
) -> Result<TokenResponse, String> {
    let response = post_json(http, url, body, timeout_ms)
        .await
        .map_err(|message| {
            format!("{label} request failed. url={url};{wire_context} details={message}")
        })?;
    if !response.ok() {
        return Err(format!(
            "{label} request failed. url={url};{wire_context} details=Error: HTTP request failed. status={}; url={url}; body={}",
            response.status, response.body
        ));
    }
    let json: serde_json::Value = serde_json::from_str(&response.body).map_err(|error| {
        format!(
            "{label} returned invalid JSON. url={url}; body={}; details=Error: {error}",
            response.body
        )
    })?;
    let access = json
        .get("access_token")
        .and_then(serde_json::Value::as_str)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| format!("{label} response missing fields: {json}"))?
        .to_string();
    let refresh = json
        .get("refresh_token")
        .and_then(serde_json::Value::as_str)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| format!("{label} response missing fields: {json}"))?
        .to_string();
    let expires_in = json
        .get("expires_in")
        .and_then(serde_json::Value::as_f64)
        .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
        .ok_or_else(|| format!("{label} response missing fields: {json}"))?;
    // The wire's expires_in is an integer second count read through JSON f64; the i64 truncation is the port's convention.
    #[allow(clippy::cast_possible_truncation)]
    let expires_in_seconds = expires_in as i64;
    Ok(TokenResponse {
        access,
        refresh,
        expires_in: expires_in_seconds,
    })
}

async fn post_json(
    http: &dyn ProviderHttp,
    url: &str,
    body: &str,
    timeout_ms: u64,
) -> Result<super::provider_http::ProviderHttpResponse, String> {
    http.request(
        ProviderHttpRequest {
            method: ProviderHttpMethod::Post,
            url: url.to_string(),
            headers: vec![
                ("Content-Type".to_string(), "application/json".to_string()),
                ("Accept".to_string(), "application/json".to_string()),
            ],
            body: Some(body.to_string()),
            follow_redirects: true,
        },
        timeout_ms,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use tokio::io::AsyncWriteExt as _;

    /// A scripted transport: url -> response, recording every posted
    /// body. Unknown urls fail the request (the TS suite throws on
    /// unexpected fetches).
    struct ScriptedHttp {
        responses: HashMap<String, super::super::provider_http::ProviderHttpResponse>,
        requests: Mutex<Vec<(String, String)>>,
    }

    impl ScriptedHttp {
        fn new(responses: Vec<(&str, u16, &str)>) -> Self {
            ScriptedHttp {
                responses: responses
                    .into_iter()
                    .map(|(url, status, body)| {
                        (
                            url.to_string(),
                            super::super::provider_http::ProviderHttpResponse {
                                status,
                                body: body.to_string(),
                            },
                        )
                    })
                    .collect(),
                requests: Mutex::new(Vec::new()),
            }
        }

        fn first_body(&self, url: &str) -> String {
            self.requests
                .lock()
                .unwrap()
                .iter()
                .find(|(seen, _)| seen == url)
                .map(|(_, body)| body.clone())
                .expect("the url was requested")
        }
    }

    impl ProviderHttp for ScriptedHttp {
        fn request(
            &self,
            request: ProviderHttpRequest,
            _timeout_ms: u64,
        ) -> Pin<
            Box<
                dyn Future<
                        Output = Result<super::super::provider_http::ProviderHttpResponse, String>,
                    > + Send
                    + '_,
            >,
        > {
            self.requests.lock().unwrap().push((
                request.url.clone(),
                request.body.clone().unwrap_or_default(),
            ));
            let response = self.responses.get(&request.url).cloned();
            Box::pin(
                async move { response.ok_or_else(|| format!("{} was not scripted", request.url)) },
            )
        }
    }

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

    struct ScriptedUi {
        auth_url: Mutex<Option<String>>,
        progress: Mutex<Vec<String>>,
        manual: Option<ScriptedAnswer>,
        prompt: Option<ScriptedAnswer>,
        cancelled: Arc<AtomicBool>,
        cancel_on_auth: bool,
    }

    impl ScriptedUi {
        fn new(manual: Option<ScriptedAnswer>, prompt: Option<ScriptedAnswer>) -> Self {
            ScriptedUi {
                auth_url: Mutex::new(None),
                progress: Mutex::new(Vec::new()),
                manual,
                prompt,
                cancelled: Arc::new(AtomicBool::new(false)),
                cancel_on_auth: false,
            }
        }

        async fn captured_url(&self) -> String {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                if let Some(url) = self.auth_url.lock().unwrap().clone() {
                    return url;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "the flow never presented its url"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
    }

    impl OAuthLoginUi for ScriptedUi {
        fn on_auth(&self, url: &str, instructions: Option<&str>) {
            assert_eq!(
                instructions,
                Some(AUTH_INSTRUCTIONS),
                "the TS instructions line rides the auth url"
            );
            *self.auth_url.lock().unwrap() = Some(url.to_string());
            if self.cancel_on_auth {
                self.cancelled.store(true, Ordering::Relaxed);
            }
        }

        fn on_prompt(
            &self,
            prompt: &OAuthPrompt,
        ) -> Pin<Box<dyn Future<Output = Option<String>> + Send + '_>> {
            assert_eq!(prompt.message, PROMPT_MESSAGE);
            assert_eq!(prompt.placeholder.as_deref(), Some(REDIRECT_URI));
            self.prompt
                .as_ref()
                .map_or_else(|| Box::pin(std::future::pending()), ScriptedAnswer::future)
        }

        fn on_progress(&self, message: &str) {
            self.progress.lock().unwrap().push(message.to_string());
        }

        fn on_manual_code_input(
            &self,
        ) -> Option<Pin<Box<dyn Future<Output = Option<String>> + Send + '_>>> {
            self.manual.as_ref().map(ScriptedAnswer::future)
        }

        fn is_cancelled(&self) -> bool {
            self.cancelled.load(Ordering::Relaxed)
        }
    }

    fn token_http() -> ScriptedHttp {
        ScriptedHttp::new(vec![(
            TOKEN_URL,
            200,
            r#"{"access_token":"the-access","refresh_token":"the-refresh","expires_in":3600}"#,
        )])
    }

    /// The flow on a free loopback port (the registered port is `start`'s
    /// production bind; `a_bound_port_fails_the_start_clearly` pins it).
    async fn login_on_a_free_port(
        http: &ScriptedHttp,
        ui: &ScriptedUi,
    ) -> Result<AnthropicCredentials, String> {
        let (verifier, challenge) = generate_pkce();
        let server = AnthropicCallbackServer::bind("127.0.0.1", 0, &verifier)
            .expect("a free loopback port binds");
        login_with_server(http, ui, &server, &verifier, &challenge).await
    }

    #[tokio::test]
    async fn the_authorization_url_carries_the_ts_parameters() {
        let url = authorization_url("the-challenge", "the-verifier");
        let parsed = url::Url::parse(&url).unwrap();
        assert_eq!(parsed.host_str(), Some("claude.ai"));
        assert_eq!(parsed.path(), "/oauth/authorize");
        let param = |name: &str| {
            parsed
                .query_pairs()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.to_string())
                .unwrap_or_default()
        };
        assert_eq!(param("code"), "true");
        assert_eq!(param("client_id"), ANTHROPIC_CLIENT_ID);
        assert_eq!(param("response_type"), "code");
        assert_eq!(param("redirect_uri"), REDIRECT_URI);
        assert_eq!(param("scope"), SCOPES);
        assert_eq!(param("code_challenge"), "the-challenge");
        assert_eq!(param("code_challenge_method"), "S256");
        // TS doubles the PKCE verifier as the state.
        assert_eq!(param("state"), "the-verifier");
    }

    #[tokio::test]
    async fn the_exchange_body_matches_the_ts_grant() {
        let http = token_http();
        let ui = ScriptedUi::new(Some(ScriptedAnswer::value("the-code")), None);
        let credentials = login_on_a_free_port(&http, &ui).await.unwrap();
        assert_eq!(credentials.access, "the-access");
        assert_eq!(credentials.refresh, "the-refresh");
        // TS: expires = now + expires_in * 1000 - 5 minutes.
        // Epoch millis fit i64; the assertion's tolerance covers the cast convention.
        #[allow(clippy::cast_possible_truncation)]
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let skew = (credentials.expires - now - (3600 * 1000 - EXPIRY_SKEW_MS)).abs();
        assert!(skew < 10_000, "the expiry arithmetic: {skew}");
        let body = http.first_body(TOKEN_URL);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(json["grant_type"], "authorization_code");
        assert_eq!(json["client_id"], ANTHROPIC_CLIENT_ID);
        assert_eq!(json["code"], "the-code");
        assert_eq!(json["redirect_uri"], REDIRECT_URI);
        // The state and the verifier are the same TS secret.
        assert_eq!(json["state"], json["code_verifier"]);
        // The exchange is narrated (TS `onProgress`).
        assert!(ui
            .progress
            .lock()
            .unwrap()
            .iter()
            .any(|message| message == "Exchanging authorization code for tokens..."));
    }

    #[tokio::test]
    async fn a_failed_exchange_surfaces_the_ts_message() {
        let http = ScriptedHttp::new(vec![(TOKEN_URL, 400, "no grant")]);
        let ui = ScriptedUi::new(Some(ScriptedAnswer::value("the-code")), None);
        let error = login_on_a_free_port(&http, &ui).await.unwrap_err();
        assert_eq!(
            error,
            format!(
                "Token exchange request failed. url={TOKEN_URL}; redirect_uri={REDIRECT_URI}; response_type=authorization_code; details=Error: HTTP request failed. status=400; url={TOKEN_URL}; body=no grant"
            )
        );
    }

    #[tokio::test]
    async fn a_missing_field_exchange_names_the_response() {
        let http = ScriptedHttp::new(vec![(TOKEN_URL, 200, r#"{"access_token":"a"}"#)]);
        let ui = ScriptedUi::new(Some(ScriptedAnswer::value("the-code")), None);
        let error = login_on_a_free_port(&http, &ui).await.unwrap_err();
        assert!(
            error.starts_with("Token exchange response missing fields"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn a_failed_refresh_surfaces_the_ts_message() {
        let http = ScriptedHttp::new(vec![(TOKEN_URL, 401, "expired")]);
        let error = refresh_anthropic_token(&http, "r-old").await.unwrap_err();
        assert_eq!(
            error,
            format!(
                "Anthropic token refresh request failed. url={TOKEN_URL}; details=Error: HTTP request failed. status=401; url={TOKEN_URL}; body=expired"
            )
        );
    }

    #[tokio::test]
    async fn an_unreachable_token_endpoint_surfaces_the_transport_error() {
        // Nothing scripted: the transport fails the request.
        let http = ScriptedHttp::new(Vec::new());
        let error = refresh_anthropic_token(&http, "r-old").await.unwrap_err();
        assert!(
            error.starts_with("Anthropic token refresh request failed. url="),
            "{error}"
        );
    }

    #[tokio::test]
    async fn a_state_mismatch_fails_the_paste() {
        let http = token_http();
        let ui = ScriptedUi::new(
            Some(ScriptedAnswer::value(
                "http://localhost:53692/callback?code=abc&state=wrong",
            )),
            None,
        );
        let error = login_on_a_free_port(&http, &ui).await.unwrap_err();
        assert_eq!(error, "OAuth state mismatch");
        assert!(http.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_paste_without_a_code_falls_back_to_the_prompt() {
        let http = token_http();
        let ui = ScriptedUi::new(
            Some(ScriptedAnswer::value("   ")),
            Some(ScriptedAnswer::value("the-prompted-code")),
        );
        login_on_a_free_port(&http, &ui).await.unwrap();
        let body = http.first_body(TOKEN_URL);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(json["code"], "the-prompted-code");
    }

    #[tokio::test]
    async fn a_cancelled_paste_ends_the_login() {
        let http = token_http();
        let ui = ScriptedUi::new(Some(ScriptedAnswer::ready()), None);
        let error = login_on_a_free_port(&http, &ui).await.unwrap_err();
        assert_eq!(error, LOGIN_CANCELLED);
    }

    #[tokio::test]
    async fn a_cancelled_prompt_ends_the_login() {
        let http = token_http();
        let ui = ScriptedUi::new(
            Some(ScriptedAnswer::value("   ")),
            Some(ScriptedAnswer::ready()),
        );
        let error = login_on_a_free_port(&http, &ui).await.unwrap_err();
        assert_eq!(error, LOGIN_CANCELLED);
    }

    #[tokio::test]
    async fn a_cancelled_surface_ends_the_login_between_polls() {
        // The flag flips when the url lands: the race loop's first
        // poll-step check ends the flow before any code arrives.
        let http = token_http();
        let mut ui = ScriptedUi::new(Some(ScriptedAnswer::Pending), None);
        ui.cancel_on_auth = true;
        let error = login_on_a_free_port(&http, &ui).await.unwrap_err();
        assert_eq!(error, LOGIN_CANCELLED);
        assert!(http.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_browser_callback_wins_the_race() {
        let http = Arc::new(token_http());
        let ui = Arc::new(ScriptedUi::new(Some(ScriptedAnswer::Pending), None));
        let (verifier, challenge) = generate_pkce();
        let server = AnthropicCallbackServer::bind("127.0.0.1", 0, &verifier)
            .expect("a free loopback port binds");
        let port = server.port();
        let flow_ui = Arc::clone(&ui);
        let flow = {
            let flow_http = Arc::clone(&http);
            tokio::spawn(async move {
                login_with_server(
                    flow_http.as_ref(),
                    flow_ui.as_ref(),
                    &server,
                    &verifier,
                    &challenge,
                )
                .await
            })
        };
        let url = ui.captured_url().await;
        let state = url::Url::parse(&url)
            .unwrap()
            .query_pairs()
            .find(|(key, _)| key == "state")
            .map(|(_, value)| value.to_string())
            .expect("the authorization url carries the state");
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("the flow's callback server accepts the redirect");
        stream
            .write_all(
                format!("GET /callback?code=live-code&state={state} HTTP/1.1\r\nHost: localhost\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .expect("the redirect writes");
        let credentials = tokio::time::timeout(Duration::from_secs(10), flow)
            .await
            .expect("the flow settles once the redirect lands")
            .unwrap()
            .unwrap();
        assert_eq!(credentials.access, "the-access");
        let body = http.first_body(TOKEN_URL);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(json["code"], "live-code");
        assert_eq!(json["state"], state.as_str());
    }

    #[test]
    fn the_paste_parse_matches_the_ts_table() {
        let url = "http://localhost:53692/callback?code=abc&state=st";
        assert_eq!(
            parse_authorization_input(url),
            (Some("abc".to_string()), Some("st".to_string()))
        );
        assert_eq!(
            parse_authorization_input("abc#st"),
            (Some("abc".to_string()), Some("st".to_string()))
        );
        assert_eq!(
            parse_authorization_input("code=abc&state=st"),
            (Some("abc".to_string()), Some("st".to_string()))
        );
        assert_eq!(
            parse_authorization_input("the-code"),
            (Some("the-code".to_string()), None)
        );
        assert_eq!(parse_authorization_input("  "), (None, None));
        // The bare-code paste substitutes the verifier as the state.
        let parsed = parse_paste("the-code", "the-verifier").unwrap().unwrap();
        assert_eq!(parsed.code, "the-code");
        assert_eq!(parsed.state, "the-verifier");
    }
}
