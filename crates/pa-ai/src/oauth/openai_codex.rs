//! The `ChatGPT` Plus/Pro (Codex Subscription) OAuth flow — the port of
//! `packages/ai/src/utils/oauth/openai-codex.ts` (+ `pkce.ts`): the PKCE
//! authorization request against the app registration, the localhost
//! callback server raced against the manual paste, the token exchange,
//! the JWT account-id claim, and the token refresh. The credentials the
//! flow returns carry the TS shape (`access`, `refresh`, `expires`,
//! `accountId`) and persist under the provider id `openai-codex`.
//!
//! Cancellation follows the fleet's cooperative pattern (#2770): the
//! driving surface marks a shared flag when it exits; the flow checks it
//! between the race's poll steps and before its network steps, so an
//! exited surface never receives a completed login (a task abort cannot
//! reach a started blocking body).

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use base64::Engine as _;
use rand::Rng;
use sha2::{Digest, Sha256};
use url::Url;

use super::callback::{CallbackCode, CodexCallbackServer};
use super::CodexHttp;

/// The app registration the TS flow ships (TS `CLIENT_ID`).
pub const OPENAI_CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
/// TS `AUTHORIZE_URL`.
const AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
/// TS `TOKEN_URL`.
const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
/// The registered redirect (TS `REDIRECT_URI`): the callback server's
/// own address.
const REDIRECT_URI: &str = REDIRECT_URI;
/// TS `SCOPE`.
const SCOPE: &str = "openid profile email offline_access";
/// The TS flow's default originator.
pub const DEFAULT_ORIGINATOR: &str = "pi";
/// One token request's bound (the port's request-timeout norm).
pub const DEFAULT_TOKEN_TIMEOUT_MS: u64 = 30_000;
/// TS the `onAuth` instructions line.
const AUTH_INSTRUCTIONS: &str = "A browser window should open. Complete login to finish.";
/// TS the `onPrompt` fallback line.
const PROMPT_MESSAGE: &str = "Paste the authorization code (or full redirect URL):";
/// The cancel error the driving surface maps to the silent cancelled
/// outcome (TS the dialog throws the same text; `auth-flows.ts` matches
/// it).
pub const LOGIN_CANCELLED: &str = "Login cancelled";
/// The race's poll step: how often the loop re-checks the cooperative
/// cancel flag (the #2770 pattern — the flag is checked between poll
/// steps).
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// The credentials the flow returns and persists (TS `OAuthCredentials`
/// plus the codex provider's `accountId`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OAuthCredentials {
    pub access: String,
    pub refresh: String,
    /// Wall-clock epoch milliseconds (TS `Date.now() + expires_in * 1000`).
    pub expires: i64,
    pub account_id: String,
}

/// The login's UI surface (TS `OAuthLoginCallbacks`): the browser URL
/// block, the manual paste racing the browser callback, and the
/// fallback prompt. Implementations render the inline auth panel (the
/// TUI) or script the flow (tests).
pub trait CodexLoginUi: Send + Sync {
    /// TS `onAuth`: the authorization URL to open, plus the flow's
    /// instructions line.
    fn on_auth(&self, url: &str, instructions: &str);
    /// TS `onManualCodeInput`: the paste racing the browser callback;
    /// `None` when the surface offers none. Resolving `None` cancels
    /// the login.
    fn on_manual_code_input(&self) -> Option<Pin<Box<dyn Future<Output = Option<String>> + Send>>>;
    /// TS `onPrompt`: the fallback prompt when neither the callback
    /// nor the paste produced a code. Resolving `None` cancels the
    /// login.
    fn on_prompt(&self, message: &str) -> Pin<Box<dyn Future<Output = Option<String>> + Send>>;
    /// The driving surface's cooperative cancel state: `true` once the
    /// pane that mounted the login exited. The flow checks it between
    /// the race's poll steps and before its network steps — a task
    /// abort cannot reach a started blocking body, so the pane marks
    /// this instead (#2770). The default (`false`) serves the surfaces
    /// that never cancel mid-flow.
    fn is_cancelled(&self) -> bool {
        false
    }
}

/// Run the login (TS `loginOpenAICodex`): build the PKCE request, start
/// the callback server, present the URL, race the browser callback
/// against the manual paste, exchange the code, and return the
/// credentials to persist.
///
/// # Errors
///
/// Returns an error when the surface cancelled the login
/// ([`LOGIN_CANCELLED`]), the pasted redirect's state mismatches, no
/// authorization code ever arrives, the token exchange fails, or the
/// access token carries no account id.
pub async fn login_openai_codex(
    http: &dyn CodexHttp,
    ui: &dyn CodexLoginUi,
    originator: &str,
) -> Result<OAuthCredentials, String> {
    let (verifier, challenge) = generate_pkce();
    let state = create_state();
    let url = authorization_url(&challenge, &state, originator);
    let callback = CodexCallbackServer::start(&state).await;
    ui.on_auth(&url, AUTH_INSTRUCTIONS);

    let code = wait_for_code(&callback, ui, &state).await?;
    // The pane exited while the login waited: no exchange, no
    // credential — the exit ends the flow (TS the dialog's abort
    // signal; #2770: the flag is the seam).
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

/// Refresh an expired credential (TS `refreshOpenAICodexToken`).
///
/// # Errors
///
/// Returns an error when the token refresh fails or the fresh access
/// token carries no account id.
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

/// One token response (TS `TokenSuccess`).
struct TokenSuccess {
    access: String,
    refresh: String,
    expires: i64,
}

/// The race + the fallbacks (TS `loginOpenAICodex`'s middle): the
/// browser callback against the manual paste, then the prompt fallback.
/// The tick re-checks the cooperative cancel between poll steps.
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
    // The outcome of the race: the callback's settled code (its state
    // was validated by the server), or the manual paste's answer.
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
        // A settled callback (the server validated the state).
        CallbackOutcome::Code(Some(code)) => Some(code),
        // A settled-empty wait (a bind failure leaves the dead server):
        // with a paste surface TS awaits the manual promise before the
        // prompt fallback; without one the prompt is the only path.
        CallbackOutcome::Code(None) => {
            if manual_available {
                match manual_answer.await {
                    None => return Err(LOGIN_CANCELLED.to_string()),
                    Some(input) => parse_paste(&input, state)?,
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
    // The fallback prompt (TS `onPrompt`): neither the callback nor the
    // paste produced a code.
    let answer = ui.on_prompt(PROMPT_MESSAGE).await;
    let input = answer.ok_or_else(|| LOGIN_CANCELLED.to_string())?;
    parse_paste(&input, state)?.ok_or_else(|| "Missing authorization code".to_string())
}

/// Parse one pasted input and check its echoed state (TS
/// `parseAuthorizationInput` + the state guard).
fn parse_paste(input: &str, expected_state: &str) -> Result<Option<String>, String> {
    let (code, echoed) = parse_authorization_input(input);
    if let Some(echoed) = echoed {
        if echoed != expected_state {
            return Err("State mismatch".to_string());
        }
    }
    Ok(code)
}

/// What the race settled on.
enum CallbackOutcome {
    /// The callback wait settled: the code, or `None` when it settled
    /// empty (a dead server or a cancelled wait).
    Code(Option<String>),
    /// The manual paste answered: the input, or `None` when cancelled.
    Manual(Option<String>),
}

/// A PKCE pair (TS `generatePKCE`): the verifier is the token-exchange
/// secret, the challenge travels in the authorization URL.
fn generate_pkce() -> (String, String) {
    let verifier = base64url(&random_bytes(32));
    let challenge = base64url(Sha256::digest(verifier.as_bytes()).as_slice());
    (verifier, challenge)
}

/// A random, hex CSRF `state` (TS `createState`: 16 random bytes as
/// hex).
fn create_state() -> String {
    random_bytes(16)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn random_bytes(len: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; len];
    rand::thread_rng().fill(&mut bytes[..]);
    bytes
}

fn base64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// The authorization URL (TS `createAuthorizationFlow`'s URL: the
/// challenge, the CSRF state, the registration's redirect and scope,
/// the simplified-flow flags, and the originator).
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

/// Parse a pasted authorization input (TS `parseAuthorizationInput`): a
/// full redirect URL, a `code#state` pair, `code=`-shaped parameters, or
/// a bare code. Returns the code and the echoed state (`None` when the
/// input carries none — TS's falsy state skips the check).
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

/// The account id the access token carries (TS `getAccountId`: the
/// `chatgpt_account_id` claim under the JWT auth claim path — the
/// provider's own extraction is the one owner).
fn account_id_of(access_token: &str) -> Result<String, String> {
    crate::providers::openai_codex_responses::request::extract_account_id(access_token)
        .map_err(|_| "Failed to extract accountId from token".to_string())
}

/// One token POST's outcome validation (TS `exchangeAuthorizationCode` /
/// `refreshAccessToken` share the shape): a 2xx answer with the three
/// fields the flow requires.
async fn token_post(
    http: &dyn CodexHttp,
    params: &[(&str, &str)],
    label: &str,
) -> Result<TokenSuccess, String> {
    let body = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(params.iter().map(|(key, value)| (*key, *value)))
        .finish();
    let response = http
        .post_form(TOKEN_URL, &body, DEFAULT_TOKEN_TIMEOUT_MS)
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
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(i64::MAX, |elapsed| elapsed.as_millis() as i64);
    Ok(TokenSuccess {
        access: access.to_string(),
        refresh: refresh.to_string(),
        expires: now + (expires_in * 1000.0) as i64,
    })
}

/// TS `exchangeAuthorizationCode`: the authorization-code grant with the
/// PKCE verifier against the registered redirect.
async fn exchange_authorization_code(
    http: &dyn CodexHttp,
    code: &str,
    verifier: &str,
) -> Result<TokenSuccess, String> {
    token_post(
        http,
        &[
            ("grant_type", "authorization_code"),
            ("client_id", OPENAI_CODEX_CLIENT_ID),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", REDIRECT_URI),
        ],
        "exchange",
    )
    .await
}

/// TS `refreshAccessToken`: the refresh-token grant.
async fn refresh_access_token(
    http: &dyn CodexHttp,
    refresh_token: &str,
) -> Result<TokenSuccess, String> {
    token_post(
        http,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", OPENAI_CODEX_CLIENT_ID),
        ],
        "refresh",
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

    /// A scripted transport: url -> response, recording every posted
    /// body. Unknown urls fail the request (the TS suite throws on
    /// unexpected fetches).
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

    /// One scripted UI answer: an immediate value (`Some`), an
    /// immediate cancel (`None`), or a never-resolving surface.
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

    /// The scripted login surface: the captured authorization URL, the
    /// paste racing the callback, and the fallback prompt.
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

        /// The captured authorization URL: waits for the flow's
        /// `onAuth` — observable readiness, bounded by a deadline that
        /// fails the test (never a green-on-timeout retry loop).
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
            self.manual.as_ref().map(ScriptedAnswer::future)
        }

        fn on_prompt(
            &self,
            _message: &str,
        ) -> Pin<Box<dyn Future<Output = Option<String>> + Send>> {
            self.prompt.future()
        }

        fn is_cancelled(&self) -> bool {
            self.cancelled.load(Ordering::Relaxed)
        }
    }

    /// One fake access token: a three-segment JWT whose payload carries
    /// the account id under the TS claim path (no signature — the flow
    /// never verifies one, like the TS `atob` decode).
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

    /// The scripted token endpoint: one answer for the whole flow.
    fn token_http(access: &str) -> ScriptedHttp {
        ScriptedHttp::new(vec![(TOKEN_URL, 200, &token_body(access))])
    }

    fn first_param(body: &str, name: &str) -> String {
        url::form_urlencoded::parse(body.as_bytes())
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.to_string())
            .unwrap_or_default()
    }

    #[tokio::test]
    async fn the_exchange_body_matches_the_ts_grant() {
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
        // The manual paste carried no state: TS's falsy state skips the
        // echo check and the code is used as-is.
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
        // Nothing scripted: the transport fails the request (the
        // scripted stand-in for the request timeout).
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
        // The flag flips when the url lands: the race loop's first
        // poll-step check ends the flow before any code arrives.
        let http = token_http(&account_jwt(Some("acct-1")));
        let mut ui = ScriptedUi::new(Some(ScriptedAnswer::Pending), ScriptedAnswer::Pending);
        ui.cancel_on_auth = true;
        let error = login_openai_codex(&http, &ui, DEFAULT_ORIGINATOR)
            .await
            .unwrap_err();
        assert_eq!(error, LOGIN_CANCELLED);
        // No token request ever posted.
        assert!(http.seen_bodies(TOKEN_URL).is_empty());
    }

    #[tokio::test]
    async fn a_cancelled_paste_ends_the_login() {
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
        // The redirect carries no code: the prompt fallback answers it.
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
        // The app registration's redirect port is the flow's wire
        // contract (a bind-anywhere test would not exercise it): it is
        // held here deliberately — a busy port leaves the flow's server
        // dead either way, so the test stays deterministic — and the
        // paste surface is absent, so the prompt is the only path.
        let held = std::net::TcpListener::bind(("127.0.0.1", 1455));
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

    #[tokio::test]
    async fn the_browser_callback_wins_the_race() {
        // The app registration's redirect port is the flow's wire
        // contract (a bind-anywhere test would not exercise the real
        // listener): the flow binds its callback server and the browser
        // redirect settles the code. Skip when another process holds the
        // port — the bind-failure path is covered above.
        let Ok(probe) = std::net::TcpListener::bind(("127.0.0.1", 1455)) else {
            return; // the registered port is busy: this run cannot stage it.
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
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", 1455))
            .await
            .expect("the flow's callback server accepts the redirect");
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
        // A full redirect URL.
        assert_eq!(
            parse_authorization_input("https://auth.example/cb?code=a&state=b"),
            (Some("a".to_string()), Some("b".to_string()))
        );
        // A percent-decoded code.
        assert_eq!(
            parse_authorization_input("https://auth.example/cb?code=a%20b"),
            (Some("a b".to_string()), None)
        );
        // A `code#state` pair.
        assert_eq!(
            parse_authorization_input("the-code#the-state"),
            (Some("the-code".to_string()), Some("the-state".to_string()))
        );
        // `code=`-shaped parameters.
        assert_eq!(
            parse_authorization_input("code=a+b&state=c"),
            (Some("a b".to_string()), Some("c".to_string()))
        );
        // A bare code.
        assert_eq!(
            parse_authorization_input(" bare "),
            (Some("bare".to_string()), None)
        );
        // Empty input carries neither.
        assert_eq!(parse_authorization_input("  "), (None, None));
        // A redirect without a code.
        assert_eq!(
            parse_authorization_input("https://auth.example/cb?state=b"),
            (None, Some("b".to_string()))
        );
    }
}
