//! The `ChatGPT` (Codex Subscription) OAuth flow: the PKCE request, the
//! localhost callback server raced against the manual paste, the token
//! exchange, and the refresh. Cancellation is cooperative: the surface
//! marks a shared flag on exit; the flow checks it between poll steps.

use std::fmt::Write as _;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use base64::Engine as _;
use rand::Rng;
use sha2::{Digest, Sha256};
use url::Url;

use super::callback::CodexCallbackServer;
use super::CodexHttp;

pub const OPENAI_CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
/// The registered redirect: the callback server's own address.
const REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
const SCOPE: &str = "openid profile email offline_access";
pub const DEFAULT_ORIGINATOR: &str = "pi";
pub const DEFAULT_TOKEN_TIMEOUT_MS: u64 = 30_000;
/// The refresh runs under the auth storage's file lock, which a peer declares stale after 10
/// seconds; the request must fit inside that window.
pub const REFRESH_TIMEOUT_MS: u64 = 8_000;
const AUTH_INSTRUCTIONS: &str = "A browser window should open. Complete login to finish.";
const PROMPT_MESSAGE: &str = "Paste the authorization code (or full redirect URL):";
/// The cancel error the driving surface maps to the silent cancelled outcome.
pub const LOGIN_CANCELLED: &str = "Login cancelled";
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OAuthCredentials {
    pub access: String,
    pub refresh: String,
    /// Wall-clock epoch milliseconds.
    pub expires: i64,
    pub account_id: String,
}

/// The login's UI surface: present the authorization URL, take the
/// manual paste racing the browser callback, and the fallback prompt.
pub trait CodexLoginUi: Send + Sync {
    fn on_auth(&self, url: &str, instructions: &str);
    /// The paste racing the browser callback; resolving `None` cancels
    /// the login.
    fn on_manual_code_input(&self) -> Option<Pin<Box<dyn Future<Output = Option<String>> + Send>>>;
    /// The fallback prompt when neither the callback nor the paste
    /// produced a code; resolving `None` cancels the login.
    fn on_prompt(&self, message: &str) -> Pin<Box<dyn Future<Output = Option<String>> + Send>>;
    /// `true` once the pane that mounted the login exited: a task abort
    /// cannot reach a started blocking body, so the pane marks this.
    fn is_cancelled(&self) -> bool {
        false
    }
}

/// Race the browser callback against the manual paste, exchange the
/// code, and return the credentials to persist.
///
/// # Errors
///
/// Returns an error when the login is cancelled ([`LOGIN_CANCELLED`]), the
/// paste mismatches, the exchange fails, or the token carries no account id.
pub async fn login_openai_codex(
    http: &dyn CodexHttp,
    ui: &dyn CodexLoginUi,
    originator: &str,
) -> Result<OAuthCredentials, String> {
    if ui.is_cancelled() {
        return Err(LOGIN_CANCELLED.to_string());
    }
    let (verifier, challenge) = generate_pkce();
    let state = create_state();
    let url = authorization_url(&challenge, &state, originator);
    let callback = CodexCallbackServer::start(&state).await;
    ui.on_auth(&url, AUTH_INSTRUCTIONS);

    let code = wait_for_code(&callback, ui, &state).await?;
    if ui.is_cancelled() {
        return Err(LOGIN_CANCELLED.to_string());
    }
    let token = exchange_authorization_code(http, &code, &verifier).await?;
    let account_id = account_id_of(&token.access)?;
    Ok(OAuthCredentials {
        access: token.access,
        refresh: token.refresh,
        expires: token.expires,
        account_id,
    })
}

/// Refresh an expired credential.
///
/// # Errors
///
/// Returns an error when the token refresh fails or the fresh access token carries no account id.
pub async fn refresh_openai_codex_token(
    http: &dyn CodexHttp,
    refresh_token: &str,
) -> Result<OAuthCredentials, String> {
    let token = refresh_access_token(http, refresh_token).await?;
    let account_id = account_id_of(&token.access)?;
    Ok(OAuthCredentials {
        access: token.access,
        refresh: token.refresh,
        expires: token.expires,
        account_id,
    })
}

struct TokenSuccess {
    access: String,
    refresh: String,
    expires: i64,
}

async fn wait_for_code(
    callback: &CodexCallbackServer,
    ui: &dyn CodexLoginUi,
    state: &str,
) -> Result<String, String> {
    let manual = ui.on_manual_code_input();
    let manual_available = manual.is_some();
    let manual_answer = async {
        match manual {
            Some(future) => future.await,
            None => std::future::pending::<Option<String>>().await,
        }
    };
    tokio::pin!(manual_answer);
    let wait = callback.wait_for_code();
    tokio::pin!(wait);
    let mut tick = tokio::time::interval(CANCEL_POLL_INTERVAL);
    let raced = loop {
        if ui.is_cancelled() {
            return Err(LOGIN_CANCELLED.to_string());
        }
        tokio::select! {
            _ = tick.tick() => {}
            code = &mut wait => break CallbackOutcome::Code(code.map(|code| code.code)),
            answer = &mut manual_answer => break CallbackOutcome::Manual(answer),
        }
    };
    let code: Option<String> = match raced {
        CallbackOutcome::Code(Some(code)) => Some(code),
        // A settled-empty wait (a bind failure leaves the dead server).
        CallbackOutcome::Code(None) => {
            if manual_available {
                match answer_or_cancelled(ui, manual_answer).await {
                    Ok(Some(input)) => parse_paste(&input, state)?,
                    Ok(None) | Err(_) => return Err(LOGIN_CANCELLED.to_string()),
                }
            } else {
                None
            }
        }
        CallbackOutcome::Manual(None) => return Err(LOGIN_CANCELLED.to_string()),
        CallbackOutcome::Manual(Some(input)) => parse_paste(&input, state)?,
    };
    if let Some(code) = code {
        return Ok(code);
    }
    let answer = answer_or_cancelled(ui, ui.on_prompt(PROMPT_MESSAGE)).await?;
    let input = answer.ok_or_else(|| LOGIN_CANCELLED.to_string())?;
    parse_paste(&input, state)?.ok_or_else(|| "Missing authorization code".to_string())
}

/// Await one answer while re-checking the cancel flag: the surface may
/// exit without ever answering.
async fn answer_or_cancelled<T>(
    ui: &dyn CodexLoginUi,
    answer: impl Future<Output = T>,
) -> Result<T, String> {
    tokio::pin!(answer);
    let mut tick = tokio::time::interval(CANCEL_POLL_INTERVAL);
    loop {
        if ui.is_cancelled() {
            return Err(LOGIN_CANCELLED.to_string());
        }
        tokio::select! {
            _ = tick.tick() => {}
            output = &mut answer => return Ok(output),
        }
    }
}

fn parse_paste(input: &str, expected_state: &str) -> Result<Option<String>, String> {
    let (code, echoed) = parse_authorization_input(input);
    if let Some(echoed) = echoed {
        if echoed != expected_state {
            return Err("State mismatch".to_string());
        }
    }
    Ok(code)
}

enum CallbackOutcome {
    /// The code, or `None` on a settled-empty wait (a dead server).
    Code(Option<String>),
    /// The paste input, or `None` when cancelled.
    Manual(Option<String>),
}

/// The verifier is the token-exchange secret; the challenge travels in
/// the authorization URL.
fn generate_pkce() -> (String, String) {
    let verifier = base64url(&random_bytes(32));
    let challenge = base64url(Sha256::digest(verifier.as_bytes()).as_slice());
    (verifier, challenge)
}

/// A random, hex CSRF `state`.
fn create_state() -> String {
    let mut state = String::with_capacity(32);
    for byte in random_bytes(16) {
        let _ = write!(state, "{byte:02x}");
    }
    state
}

fn random_bytes(len: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; len];
    rand::thread_rng().fill(&mut bytes[..]);
    bytes
}

fn base64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn authorization_url(challenge: &str, state: &str, originator: &str) -> String {
    let mut url = Url::parse(AUTHORIZE_URL).expect("the authorize url parses");
    for (name, value) in [
        ("response_type", "code"),
        ("client_id", OPENAI_CODEX_CLIENT_ID),
        ("redirect_uri", REDIRECT_URI),
        ("scope", SCOPE),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
        ("state", state),
        ("id_token_add_organizations", "true"),
        ("codex_cli_simplified_flow", "true"),
        ("originator", originator),
    ] {
        url.query_pairs_mut().append_pair(name, value);
    }
    url.to_string()
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

/// The provider's own extraction is the one owner of the claim path.
fn account_id_of(access_token: &str) -> Result<String, String> {
    crate::providers::openai_codex_responses::request::extract_account_id(access_token)
        .map_err(|_| "Failed to extract accountId from token".to_string())
}

async fn token_post_bounded(
    http: &dyn CodexHttp,
    params: &[(&str, &str)],
    label: &str,
    timeout_ms: u64,
) -> Result<TokenSuccess, String> {
    let body = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(params.iter().map(|(key, value)| (*key, *value)))
        .finish();
    let response = http
        .post_form(TOKEN_URL, &body, timeout_ms)
        .await
        .map_err(|message| format!("OpenAI Codex token {label} error: {message}"))?;
    if !response.ok() {
        // TS falls back to `response.statusText` when the body is empty.
        let text = if response.body.is_empty() {
            format!("HTTP {}", response.status)
        } else {
            response.body.clone()
        };
        return Err(format!(
            "OpenAI Codex token {label} failed ({}): {text}",
            response.status
        ));
    }
    let json: serde_json::Value =
        serde_json::from_str(&response.body).map_err(|_| response.body.clone())?;
    let Some(access) = json
        .get("access_token")
        .and_then(serde_json::Value::as_str)
        .filter(|token| !token.is_empty())
    else {
        return Err(format!(
            "OpenAI Codex token {label} response missing fields: {json}"
        ));
    };
    let Some(refresh) = json
        .get("refresh_token")
        .and_then(serde_json::Value::as_str)
        .filter(|token| !token.is_empty())
    else {
        return Err(format!(
            "OpenAI Codex token {label} response missing fields: {json}"
        ));
    };
    let Some(expires_in) = json.get("expires_in").and_then(serde_json::Value::as_f64) else {
        return Err(format!(
            "OpenAI Codex token {label} response missing fields: {json}"
        ));
    };
    if !expires_in.is_finite() {
        // A NaN/`inf` lifetime is not a lifetime (TS's arithmetic yields
        // a never-expiring credential; the port refuses it).
        return Err(format!(
            "OpenAI Codex token {label} response missing fields: {json}"
        ));
    }
    // Epoch millis fit i64 for ~292 million years.
    #[allow(clippy::cast_possible_truncation)]
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(i64::MAX, |elapsed| elapsed.as_millis() as i64);
    // Saturating: an oversized `expires_in` cannot overflow the sum.
    // The wire's expires_in is a second count read through JSON f64; i64 ms is the credentials' convention.
    #[allow(clippy::cast_possible_truncation)]
    let expires = now.saturating_add((expires_in * 1000.0) as i64);
    Ok(TokenSuccess {
        access: access.to_string(),
        refresh: refresh.to_string(),
        expires,
    })
}

async fn exchange_authorization_code(
    http: &dyn CodexHttp,
    code: &str,
    verifier: &str,
) -> Result<TokenSuccess, String> {
    token_post_bounded(
        http,
        &[
            ("grant_type", "authorization_code"),
            ("client_id", OPENAI_CODEX_CLIENT_ID),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", REDIRECT_URI),
        ],
        "exchange",
        DEFAULT_TOKEN_TIMEOUT_MS,
    )
    .await
}

async fn refresh_access_token(
    http: &dyn CodexHttp,
    refresh_token: &str,
) -> Result<TokenSuccess, String> {
    token_post_bounded(
        http,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", OPENAI_CODEX_CLIENT_ID),
        ],
        "refresh",
        REFRESH_TIMEOUT_MS,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oauth::CodexHttpResponse;
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use tokio::io::AsyncWriteExt as _;

    /// Every flow binds the one fixed redirect port while the tests run on parallel threads: each
    /// flow stages it under this lock. The guard is held across the flow's awaits by design.
    static REDIRECT_PORT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    struct ScriptedHttp {
        responses: std::collections::HashMap<String, CodexHttpResponse>,
        seen: Mutex<Vec<(String, String)>>,
    }

    impl ScriptedHttp {
        fn new(responses: Vec<(&str, u16, &str)>) -> Self {
            ScriptedHttp {
                responses: responses
                    .into_iter()
                    .map(|(url, status, body)| {
                        (
                            url.to_string(),
                            CodexHttpResponse {
                                status,
                                body: body.to_string(),
                            },
                        )
                    })
                    .collect(),
                seen: Mutex::new(Vec::new()),
            }
        }

        fn seen_bodies(&self, url: &str) -> Vec<String> {
            self.seen
                .lock()
                .unwrap()
                .iter()
                .filter(|(seen_url, _)| seen_url == url)
                .map(|(_, body)| body.clone())
                .collect()
        }
    }

    impl CodexHttp for ScriptedHttp {
        fn post_form<'a>(
            &'a self,
            url: &'a str,
            body: &'a str,
            _timeout_ms: u64,
        ) -> Pin<Box<dyn Future<Output = Result<CodexHttpResponse, String>> + Send + 'a>> {
            self.seen
                .lock()
                .unwrap()
                .push((url.to_string(), body.to_string()));
            let response = self.responses.get(url).cloned();
            Box::pin(async move { response.ok_or_else(|| format!("{url} was not scripted")) })
        }
    }

    enum ScriptedAnswer {
        Once(Option<String>),
        Pending,
        PendingMarksCancel,
    }

    impl ScriptedAnswer {
        fn ready() -> Self {
            ScriptedAnswer::Once(None)
        }

        fn value(text: &str) -> Self {
            ScriptedAnswer::Once(Some(text.to_string()))
        }

        fn future(
            &self,
            cancel: &Arc<AtomicBool>,
        ) -> Pin<Box<dyn Future<Output = Option<String>> + Send>> {
            match self {
                ScriptedAnswer::Once(value) => {
                    let value = value.clone();
                    Box::pin(std::future::ready(value))
                }
                ScriptedAnswer::Pending => Box::pin(std::future::pending()),
                ScriptedAnswer::PendingMarksCancel => {
                    let cancel = Arc::clone(cancel);
                    Box::pin(async move {
                        cancel.store(true, Ordering::Relaxed);
                        std::future::pending::<Option<String>>().await
                    })
                }
            }
        }
    }

    struct ScriptedUi {
        auth_url: Mutex<Option<String>>,
        manual: Option<ScriptedAnswer>,
        prompt: ScriptedAnswer,
        cancelled: Arc<AtomicBool>,
        cancel_on_auth: bool,
    }

    impl ScriptedUi {
        fn new(manual: Option<ScriptedAnswer>, prompt: ScriptedAnswer) -> Self {
            ScriptedUi {
                auth_url: Mutex::new(None),
                manual,
                prompt,
                cancelled: Arc::new(AtomicBool::new(false)),
                cancel_on_auth: false,
            }
        }

        /// Waits for the flow's `onAuth`, bounded by a deadline that
        /// fails the test.
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
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }
    }

    impl CodexLoginUi for ScriptedUi {
        fn on_auth(&self, url: &str, _instructions: &str) {
            *self.auth_url.lock().unwrap() = Some(url.to_string());
            if self.cancel_on_auth {
                self.cancelled.store(true, Ordering::Relaxed);
            }
        }

        fn on_manual_code_input(
            &self,
        ) -> Option<Pin<Box<dyn Future<Output = Option<String>> + Send>>> {
            self.manual
                .as_ref()
                .map(|manual| manual.future(&self.cancelled))
        }

        fn on_prompt(
            &self,
            _message: &str,
        ) -> Pin<Box<dyn Future<Output = Option<String>> + Send>> {
            self.prompt.future(&self.cancelled)
        }

        fn is_cancelled(&self) -> bool {
            self.cancelled.load(Ordering::Relaxed)
        }
    }

    /// A fake three-segment JWT with the account id claim; no signature
    /// — the flow never verifies one.
    fn account_jwt(account_id: Option<&str>) -> String {
        let payload = match account_id {
            Some(account_id) => json!({
                "https://api.openai.com/auth": {"chatgpt_account_id": account_id}
            }),
            None => json!({"sub": "someone"}),
        };
        let segment =
            |value: serde_json::Value| base64url(serde_json::to_string(&value).unwrap().as_bytes());
        format!(
            "{}.{}.not-a-signature",
            segment(json!({"alg": "RS256"})),
            segment(payload)
        )
    }

    fn token_body(access: &str) -> String {
        json!({
            "access_token": access,
            "refresh_token": "r-1",
            "expires_in": 3600,
        })
        .to_string()
    }

    fn token_http(access: &str) -> ScriptedHttp {
        ScriptedHttp::new(vec![(TOKEN_URL, 200, &token_body(access))])
    }

    fn first_param(body: &str, name: &str) -> String {
        url::form_urlencoded::parse(body.as_bytes())
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.to_string())
            .unwrap_or_default()
    }

    /// Stage the registered redirect port busy on the flow's own host (`PI_OAUTH_CALLBACK_HOST`):
    /// an active listener blocks the same-address bind (both sockets set `SO_REUSEADDR`, neither
    /// sets `SO_REUSEPORT`), so the flow's callback server is dead. `None`: the port cannot be
    /// staged this run.
    fn stage_busy_registered_port() -> Option<std::net::TcpListener> {
        let host = std::env::var(crate::oauth::callback::CALLBACK_HOST_ENV)
            .unwrap_or_else(|_| "127.0.0.1".to_string());
        std::net::TcpListener::bind((host, 1455)).ok()
    }

    #[tokio::test]
    async fn the_exchange_body_matches_the_ts_grant() {
        let _registered_port = REDIRECT_PORT.lock().await;
        let http = token_http(&account_jwt(Some("acct-1")));
        let ui = ScriptedUi::new(
            Some(ScriptedAnswer::value(&format!("{REDIRECT_URI}?code=abc"))),
            ScriptedAnswer::ready(),
        );
        let credentials = login_openai_codex(&http, &ui, DEFAULT_ORIGINATOR)
            .await
            .unwrap();
        assert_eq!(credentials.account_id, "acct-1");
        assert_eq!(credentials.refresh, "r-1");
        assert!(credentials.expires > 0);
        let body = &http.seen_bodies(TOKEN_URL)[0];
        assert_eq!(first_param(body, "grant_type"), "authorization_code");
        assert_eq!(first_param(body, "client_id"), OPENAI_CODEX_CLIENT_ID);
        assert_eq!(first_param(body, "code"), "abc");
        assert_eq!(first_param(body, "redirect_uri"), REDIRECT_URI);
        let verifier = first_param(body, "code_verifier");
        assert_eq!(
            verifier.len(),
            43,
            "the PKCE verifier is 32 base64url bytes"
        );
    }

    #[tokio::test]
    async fn the_refresh_body_matches_the_ts_grant() {
        let http = token_http(&account_jwt(Some("acct-1")));
        let credentials = refresh_openai_codex_token(&http, "r-old").await.unwrap();
        assert_eq!(credentials.account_id, "acct-1");
        assert_eq!(credentials.access, account_jwt(Some("acct-1")));
        let body = &http.seen_bodies(TOKEN_URL)[0];
        assert_eq!(first_param(body, "grant_type"), "refresh_token");
        assert_eq!(first_param(body, "refresh_token"), "r-old");
        assert_eq!(first_param(body, "client_id"), OPENAI_CODEX_CLIENT_ID);
    }

    #[tokio::test]
    async fn a_failed_exchange_surfaces_the_ts_message() {
        let _registered_port = REDIRECT_PORT.lock().await;
        let http = ScriptedHttp::new(vec![(TOKEN_URL, 400, "no grant")]);
        let ui = ScriptedUi::new(
            Some(ScriptedAnswer::value(&format!("{REDIRECT_URI}?code=abc"))),
            ScriptedAnswer::ready(),
        );
        let error = login_openai_codex(&http, &ui, DEFAULT_ORIGINATOR)
            .await
            .unwrap_err();
        assert_eq!(error, "OpenAI Codex token exchange failed (400): no grant");
    }

    #[tokio::test]
    async fn a_missing_field_exchange_names_the_response() {
        let _registered_port = REDIRECT_PORT.lock().await;
        let http = ScriptedHttp::new(vec![(TOKEN_URL, 200, r#"{"access_token":"a"}"#)]);
        let ui = ScriptedUi::new(
            Some(ScriptedAnswer::value(&format!("{REDIRECT_URI}?code=abc"))),
            ScriptedAnswer::ready(),
        );
        let error = login_openai_codex(&http, &ui, DEFAULT_ORIGINATOR)
            .await
            .unwrap_err();
        assert_eq!(
            error,
            r#"OpenAI Codex token exchange response missing fields: {"access_token":"a"}"#
        );
    }

    #[tokio::test]
    async fn a_failed_refresh_surfaces_the_ts_message() {
        let http = ScriptedHttp::new(vec![(TOKEN_URL, 401, "expired")]);
        let error = refresh_openai_codex_token(&http, "r-old")
            .await
            .unwrap_err();
        assert_eq!(error, "OpenAI Codex token refresh failed (401): expired");
    }

    #[tokio::test]
    async fn an_unreachable_token_endpoint_surfaces_a_transport_error() {
        // Nothing scripted: the transport fails the request.
        let http = ScriptedHttp::new(Vec::new());
        let error = refresh_openai_codex_token(&http, "r-old")
            .await
            .unwrap_err();
        assert!(
            error.starts_with("OpenAI Codex token refresh error:"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn a_token_without_the_account_id_fails_the_login() {
        let _registered_port = REDIRECT_PORT.lock().await;
        let http = token_http(&account_jwt(None));
        let ui = ScriptedUi::new(
            Some(ScriptedAnswer::value(&format!("{REDIRECT_URI}?code=abc"))),
            ScriptedAnswer::ready(),
        );
        let error = login_openai_codex(&http, &ui, DEFAULT_ORIGINATOR)
            .await
            .unwrap_err();
        assert_eq!(error, "Failed to extract accountId from token");
    }

    #[tokio::test]
    async fn a_cancelled_surface_ends_the_login_between_polls() {
        let _registered_port = REDIRECT_PORT.lock().await;
        // The flag flips when the url lands: the first poll-step check
        // ends the flow.
        let http = token_http(&account_jwt(Some("acct-1")));
        let mut ui = ScriptedUi::new(Some(ScriptedAnswer::Pending), ScriptedAnswer::Pending);
        ui.cancel_on_auth = true;
        let error = login_openai_codex(&http, &ui, DEFAULT_ORIGINATOR)
            .await
            .unwrap_err();
        assert_eq!(error, LOGIN_CANCELLED);
        assert!(http.seen_bodies(TOKEN_URL).is_empty());
    }

    #[tokio::test]
    async fn a_cancelled_paste_ends_the_login() {
        let _registered_port = REDIRECT_PORT.lock().await;
        let http = token_http(&account_jwt(Some("acct-1")));
        let ui = ScriptedUi::new(
            Some(ScriptedAnswer::ready()),
            ScriptedAnswer::value("late-code"),
        );
        let error = login_openai_codex(&http, &ui, DEFAULT_ORIGINATOR)
            .await
            .unwrap_err();
        assert_eq!(error, LOGIN_CANCELLED);
    }

    #[tokio::test]
    async fn a_state_mismatch_fails_the_paste() {
        let _registered_port = REDIRECT_PORT.lock().await;
        let http = token_http(&account_jwt(Some("acct-1")));
        let ui = ScriptedUi::new(
            Some(ScriptedAnswer::value(&format!(
                "{REDIRECT_URI}?code=abc&state=not-ours"
            ))),
            ScriptedAnswer::ready(),
        );
        let error = login_openai_codex(&http, &ui, DEFAULT_ORIGINATOR)
            .await
            .unwrap_err();
        assert_eq!(error, "State mismatch");
    }

    #[tokio::test]
    async fn a_paste_without_a_code_falls_back_to_the_prompt() {
        let _registered_port = REDIRECT_PORT.lock().await;
        let http = token_http(&account_jwt(Some("acct-1")));
        let ui = ScriptedUi::new(
            Some(ScriptedAnswer::value(REDIRECT_URI)),
            ScriptedAnswer::value("prompted-code"),
        );
        let credentials = login_openai_codex(&http, &ui, DEFAULT_ORIGINATOR)
            .await
            .unwrap();
        assert_eq!(credentials.account_id, "acct-1");
        assert_eq!(
            first_param(&http.seen_bodies(TOKEN_URL)[0], "code"),
            "prompted-code"
        );
    }

    #[tokio::test]
    async fn a_cancelled_prompt_ends_the_login() {
        let _registered_port = REDIRECT_PORT.lock().await;
        let http = token_http(&account_jwt(Some("acct-1")));
        let ui = ScriptedUi::new(
            Some(ScriptedAnswer::value(REDIRECT_URI)),
            ScriptedAnswer::ready(),
        );
        let error = login_openai_codex(&http, &ui, DEFAULT_ORIGINATOR)
            .await
            .unwrap_err();
        assert_eq!(error, LOGIN_CANCELLED);
    }

    #[tokio::test]
    async fn an_empty_prompt_answer_reports_the_missing_code() {
        let _registered_port = REDIRECT_PORT.lock().await;
        let http = token_http(&account_jwt(Some("acct-1")));
        let ui = ScriptedUi::new(
            Some(ScriptedAnswer::value(REDIRECT_URI)),
            ScriptedAnswer::value("  "),
        );
        let error = login_openai_codex(&http, &ui, DEFAULT_ORIGINATOR)
            .await
            .unwrap_err();
        assert_eq!(error, "Missing authorization code");
    }

    #[tokio::test]
    async fn a_dead_callback_falls_to_the_prompt_without_a_paste_surface() {
        let _registered_port = REDIRECT_PORT.lock().await;
        let Some(held) = stage_busy_registered_port() else {
            return;
        };
        let http = token_http(&account_jwt(Some("acct-1")));
        let ui = ScriptedUi::new(None, ScriptedAnswer::value("the-code"));
        let credentials = tokio::time::timeout(
            Duration::from_secs(10),
            login_openai_codex(&http, &ui, DEFAULT_ORIGINATOR),
        )
        .await
        .expect("the dead-server flow settles promptly")
        .unwrap();
        assert_eq!(credentials.account_id, "acct-1");
        assert_eq!(
            first_param(&http.seen_bodies(TOKEN_URL)[0], "code"),
            "the-code"
        );
        drop(held);
    }

    /// Pins the staging premise: a staged listener blocks the flow's bind and the released port
    /// hosts it again, so any staging that stops blocking reds here.
    #[tokio::test]
    async fn the_staged_registered_port_blocks_the_flow_bind() {
        let _registered_port = REDIRECT_PORT.lock().await;
        let Some(held) = stage_busy_registered_port() else {
            return;
        };
        let blocked = CodexCallbackServer::bind("127.0.0.1", 1455, "the-state").await;
        assert!(
            blocked.is_err(),
            "the staged port must block the flow's callback bind"
        );
        drop(held);
        let live = CodexCallbackServer::bind("127.0.0.1", 1455, "the-state").await;
        assert!(
            live.is_ok(),
            "the released port hosts the flow's callback bind again"
        );
    }

    /// Regression: a dead callback server plus a never-resolving paste
    /// must end on the cancel flag, never hang the wait.
    #[tokio::test]
    async fn a_pending_paste_never_holds_a_cancelled_flow() {
        let _registered_port = REDIRECT_PORT.lock().await;
        let Some(held) = stage_busy_registered_port() else {
            return;
        };
        let http = token_http(&account_jwt(Some("acct-1")));
        let ui = ScriptedUi::new(
            Some(ScriptedAnswer::PendingMarksCancel),
            ScriptedAnswer::Pending,
        );
        let error = tokio::time::timeout(
            Duration::from_secs(2),
            login_openai_codex(&http, &ui, DEFAULT_ORIGINATOR),
        )
        .await
        .expect("the cancelled wait returns instead of hanging")
        .unwrap_err();
        assert_eq!(error, LOGIN_CANCELLED);
        assert!(http.seen_bodies(TOKEN_URL).is_empty());
        drop(held);
    }

    /// Without a paste surface the cancel flag is the only bound on the callback wait: the login
    /// must end cancelled with no exchange, whichever way its callback server's bind went.
    #[tokio::test]
    async fn a_cancelled_surface_ends_a_login_without_a_paste_surface() {
        let _registered_port = REDIRECT_PORT.lock().await;
        let http = token_http(&account_jwt(Some("acct-1")));
        let ui = ScriptedUi::new(None, ScriptedAnswer::Pending);
        let cancel = Arc::clone(&ui.cancelled);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            cancel.store(true, Ordering::Relaxed);
        });
        let error = tokio::time::timeout(
            Duration::from_secs(2),
            login_openai_codex(&http, &ui, DEFAULT_ORIGINATOR),
        )
        .await
        .expect("the no-paste login ends on the surface's cancel")
        .unwrap_err();
        assert_eq!(error, LOGIN_CANCELLED);
        assert!(http.seen_bodies(TOKEN_URL).is_empty());
    }

    #[tokio::test]
    async fn the_browser_callback_wins_the_race() {
        let _registered_port = REDIRECT_PORT.lock().await;
        // Skip when another process holds the registered port; the
        // bind-failure path is covered above.
        let Ok(probe) = std::net::TcpListener::bind(("127.0.0.1", 1455)) else {
            return;
        };
        drop(probe);
        let http = Arc::new(token_http(&account_jwt(Some("acct-live"))));
        let ui = Arc::new(ScriptedUi::new(
            Some(ScriptedAnswer::Pending),
            ScriptedAnswer::Pending,
        ));
        let flow_ui = Arc::clone(&ui);
        let flow = {
            let flow_http = Arc::clone(&http);
            tokio::spawn(async move {
                login_openai_codex(flow_http.as_ref(), flow_ui.as_ref(), DEFAULT_ORIGINATOR).await
            })
        };
        let url = ui.captured_url().await;
        let state = url::Url::parse(&url)
            .unwrap()
            .query_pairs()
            .find(|(key, _)| key == "state")
            .map(|(_, value)| value.to_string())
            .expect("the authorization url carries the state");
        // A refused connect here is a port stolen after the probe: wait for the listener itself,
        // bounded by a deadline that fails the test.
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        let mut stream = loop {
            match tokio::net::TcpStream::connect(("127.0.0.1", 1455)).await {
                Ok(stream) => break stream,
                Err(error) => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "the flow's callback server never listened: {error}"
                    );
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            }
        };
        stream
            .write_all(
                format!("GET /auth/callback?code=live-code&state={state} HTTP/1.1\r\nHost: localhost\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .expect("the redirect writes");
        let credentials = tokio::time::timeout(Duration::from_secs(10), flow)
            .await
            .expect("the flow settles once the redirect lands")
            .unwrap()
            .unwrap();
        assert_eq!(credentials.account_id, "acct-live");
        assert_eq!(
            first_param(&http.seen_bodies(TOKEN_URL)[0], "code"),
            "live-code"
        );
    }

    #[test]
    fn the_authorization_url_carries_the_ts_parameters() {
        let url = authorization_url("the-challenge", "the-state", "pi");
        let parsed = url::Url::parse(&url).unwrap();
        assert_eq!(parsed.host_str(), Some("auth.openai.com"));
        assert_eq!(parsed.path(), "/oauth/authorize");
        let param = |name: &str| {
            parsed
                .query_pairs()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.to_string())
                .unwrap_or_default()
        };
        assert_eq!(param("response_type"), "code");
        assert_eq!(param("client_id"), OPENAI_CODEX_CLIENT_ID);
        assert_eq!(param("redirect_uri"), REDIRECT_URI);
        assert_eq!(param("scope"), SCOPE);
        assert_eq!(param("code_challenge"), "the-challenge");
        assert_eq!(param("code_challenge_method"), "S256");
        assert_eq!(param("state"), "the-state");
        assert_eq!(param("id_token_add_organizations"), "true");
        assert_eq!(param("codex_cli_simplified_flow"), "true");
        assert_eq!(param("originator"), "pi");
    }

    #[tokio::test]
    async fn the_pkce_pair_matches_the_ts_shapes() {
        let (verifier, challenge) = generate_pkce();
        assert_eq!(verifier.len(), 43);
        assert_eq!(
            challenge,
            base64url(Sha256::digest(verifier.as_bytes()).as_slice())
        );
        let state = create_state();
        assert_eq!(state.len(), 32);
        assert!(state.chars().all(|character| character.is_ascii_hexdigit()));
    }

    #[test]
    fn the_pasted_input_parses_like_the_ts_table() {
        assert_eq!(
            parse_authorization_input("https://auth.example/cb?code=a&state=b"),
            (Some("a".to_string()), Some("b".to_string()))
        );
        assert_eq!(
            parse_authorization_input("https://auth.example/cb?code=a%20b"),
            (Some("a b".to_string()), None)
        );
        assert_eq!(
            parse_authorization_input("the-code#the-state"),
            (Some("the-code".to_string()), Some("the-state".to_string()))
        );
        assert_eq!(
            parse_authorization_input("code=a+b&state=c"),
            (Some("a b".to_string()), Some("c".to_string()))
        );
        assert_eq!(
            parse_authorization_input(" bare "),
            (Some("bare".to_string()), None)
        );
        assert_eq!(parse_authorization_input("  "), (None, None));
        assert_eq!(
            parse_authorization_input("https://auth.example/cb?state=b"),
            (None, Some("b".to_string()))
        );
    }
}
