//! Prime Agent Traces login (TS `prime-inference-auth.ts`'s traces arms):
//! the `agent_traces` scope check and the browser challenge — the RSA
//! `auth_challenge` flow that yields a Prime API key with trace write
//! access, plus the prime-cli credential reuse the login tries first.
//! The interactive surface (the URL display, the paste fallback) lives in
//! the composition root; this module owns the protocol.

use std::path::Path;
use std::time::Duration;

use base64::Engine as _;
use rsa::pkcs8::EncodePublicKey;
use serde_json::{json, Value};

use super::prime_inference::{
    check_prime_scope_access, normalize_base_url, read_prime_cli_config, read_response_message,
    PrimeAccessError, PrimeHttp, DEFAULT_PRIME_API_BASE_URL, DEFAULT_PRIME_FRONTEND_URL,
    DEFAULT_REQUEST_TIMEOUT_MS,
};

/// TS `PRIME_AGENT_TRACES_PROVIDER_ID`.
pub const PRIME_AGENT_TRACES_PROVIDER_ID: &str = "prime-agent-traces";
/// TS `PRIME_AGENT_TRACES_PROVIDER_NAME`.
pub const PRIME_AGENT_TRACES_PROVIDER_NAME: &str = "Prime Agent Traces";
/// TS `DEFAULT_POLL_INTERVAL_MS` (the challenge status poll).
pub const DEFAULT_POLL_INTERVAL_MS: u64 = 5_000;

/// TS `resolvePrimeAgentTracesBaseUrl`: the override (or the env key)
/// normalized, else the platform default.
pub fn resolve_prime_agent_traces_base_url(base_url: Option<&str>) -> String {
    let override_url = base_url
        .map(str::to_string)
        .or_else(|| std::env::var("PRIME_AGENT_TRACES_BASE_URL").ok());
    normalize_base_url(override_url.as_deref())
}

/// TS `resolvePrimeAgentTracesChallengeConfig`: the challenge runs
/// against the traces base URL with the production frontend.
fn resolve_prime_agent_traces_challenge_config() -> (String, String) {
    (
        resolve_prime_agent_traces_base_url(None),
        DEFAULT_PRIME_FRONTEND_URL.to_string(),
    )
}

/// TS `checkPrimeAgentTracesAccess`: the stored or pasted key must carry
/// the `agent_traces` write permission.
pub async fn check_prime_agent_traces_access(
    http: &dyn PrimeHttp,
    base_url: &str,
    api_key: &str,
    timeout_ms: u64,
) -> Result<(), PrimeAccessError> {
    check_prime_scope_access(
        http,
        base_url,
        api_key,
        timeout_ms,
        "agent_traces",
        "agent trace",
    )
    .await
}

/// The browser auth info TS `onAuth` receives: the challenge URL and the
/// code line (the dialog shows both).
pub struct PrimeAuthInfo {
    pub url: String,
    pub instructions: String,
}

/// The login's callbacks (TS `PrimeInferenceLoginCallbacks`): the auth
/// surface and the progress line.
pub struct PrimeAgentTracesCallbacks<'a> {
    pub on_auth: &'a (dyn Fn(&PrimeAuthInfo) + Send + Sync),
    pub on_progress: Option<&'a (dyn Fn(&str) + Send + Sync)>,
}

impl PrimeAgentTracesCallbacks<'_> {
    fn progress(&self, message: &str) {
        if let Some(on_progress) = self.on_progress {
            on_progress(message);
        }
    }
}

/// TS `PrimeInferenceLoginOptions`: the prime-cli reuse and the poll and
/// request timing.
pub struct PrimeAgentTracesLoginOptions<'a> {
    pub prime_cli_config_path: Option<&'a Path>,
    pub use_prime_cli_config: bool,
    pub poll_interval_ms: Option<u64>,
    pub request_timeout_ms: Option<u64>,
}

impl<'a> PrimeAgentTracesLoginOptions<'a> {
    /// TS the default options object (`{}`): the prime-cli reuse is on,
    /// the path and the timing come from the caller's inputs.
    pub fn new(prime_cli_config_path: Option<&'a Path>) -> Self {
        PrimeAgentTracesLoginOptions {
            prime_cli_config_path,
            use_prime_cli_config: prime_cli_config_path.is_some(),
            poll_interval_ms: None,
            request_timeout_ms: None,
        }
    }
}

/// TS `PrimeInferenceLoginResult`'s `source`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrimeAgentTracesLoginSource {
    PrimeCli,
    Browser,
}

/// One challenge round (TS `PrimeChallengeResponse`).
struct PrimeChallenge {
    challenge: String,
    status_auth_token: String,
}

/// TS `generatePrimeChallenge`: POST the public key, read the challenge
/// and the status token.
async fn generate_prime_challenge(
    http: &dyn PrimeHttp,
    base_url: &str,
    public_key: &str,
    timeout_ms: u64,
) -> Result<PrimeChallenge, String> {
    let url = format!("{base_url}/api/v1/auth_challenge/generate");
    let body = json!({"encryptionPublicKey": public_key}).to_string();
    let response = http.post_json(&url, &body, None, timeout_ms).await?;
    if !(200..300).contains(&response.status) {
        return Err(format!(
            "Failed to generate Prime login challenge: {}",
            read_response_message(response.status, &response.body)
        ));
    }
    let data: Value = serde_json::from_str(&response.body)
        .map_err(|_| "Prime login challenge returned an invalid response".to_string())
        .and_then(|data: Value| {
            data.is_object()
                .then_some(data)
                .ok_or_else(|| "Prime login challenge returned an invalid response".to_string())
        })?;
    let string_field = |key: &str| {
        data.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let Some(challenge) = string_field("challenge") else {
        return Err("Prime login challenge response missing required fields".to_string());
    };
    let Some(status_auth_token) = string_field("status_auth_token") else {
        return Err("Prime login challenge response missing required fields".to_string());
    };
    Ok(PrimeChallenge {
        challenge,
        status_auth_token,
    })
}

/// TS `pollPrimeChallengeResult`: poll the status until the encrypted
/// result lands, then decrypt the API key (RSA-OAEP-SHA256).
async fn poll_prime_challenge_result(
    http: &dyn PrimeHttp,
    base_url: &str,
    challenge: &PrimeChallenge,
    private_key: &rsa::RsaPrivateKey,
    timeout_ms: u64,
    poll_interval_ms: u64,
) -> Result<String, String> {
    loop {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("challenge", &challenge.challenge)
            .finish();
        let status_url = format!("{base_url}/api/v1/auth_challenge/status?{query}");
        let response = http
            .get(&status_url, &challenge.status_auth_token, timeout_ms)
            .await?;
        if response.status == 404 {
            return Err("Prime login challenge expired".to_string());
        }
        if !(200..300).contains(&response.status) {
            return Err(format!(
                "Failed to check Prime login status: {}",
                read_response_message(response.status, &response.body)
            ));
        }
        let data: Value = serde_json::from_str(&response.body)
            .map_err(|_| "Prime login status returned an invalid response".to_string())
            .and_then(|data: Value| {
                data.is_object()
                    .then_some(data)
                    .ok_or_else(|| "Prime login status returned an invalid response".to_string())
            })?;
        if let Some(encrypted) = data
            .get("result")
            .and_then(Value::as_str)
            .filter(|result| !result.is_empty())
        {
            return decrypt_prime_challenge_result(private_key, encrypted);
        }
        tokio::time::sleep(Duration::from_millis(poll_interval_ms)).await;
    }
}

/// TS `decryptPrimeChallengeResult`: RSA-OAEP-SHA256 over the base64
/// result.
fn decrypt_prime_challenge_result(
    private_key: &rsa::RsaPrivateKey,
    encrypted_result: &str,
) -> Result<String, String> {
    let ciphertext = base64::engine::general_purpose::STANDARD
        .decode(encrypted_result.as_bytes())
        .map_err(|_| "Prime login challenge result could not be decoded".to_string())?;
    let padding = rsa::Oaep::new::<sha2::Sha256>();
    let decrypted = private_key
        .decrypt(padding, &ciphertext)
        .map_err(|_| "Prime login challenge result could not be decrypted".to_string())?;
    String::from_utf8(decrypted)
        .map_err(|_| "Prime login challenge result is not UTF-8".to_string())
}

/// TS `runPrimeBrowserLogin` (scope `agent_traces`): the keypair, the
/// challenge, the auth URL callback, and the status poll.
async fn run_prime_browser_login(
    http: &dyn PrimeHttp,
    base_url: &str,
    frontend_url: &str,
    callbacks: &PrimeAgentTracesCallbacks<'_>,
    timeout_ms: u64,
    poll_interval_ms: u64,
) -> Result<String, String> {
    let mut rng = rsa::rand_core::OsRng;
    let private_key = rsa::RsaPrivateKey::new(&mut rng, 2048).map_err(|error| error.to_string())?;
    let public_key = private_key
        .to_public_key()
        .to_public_key_pem(rsa::pkcs8::LineEnding::LF)
        .map_err(|error| error.to_string())?;
    let challenge = generate_prime_challenge(http, base_url, &public_key, timeout_ms).await?;
    // TS builds the URL with `URLSearchParams` (space encodes as `+`):
    // the query carries both the code and the traces scope.
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("code", &challenge.challenge)
        .append_pair("scope", "agent_traces")
        .finish();
    let auth_url = format!("{frontend_url}/dashboard/tokens/challenge?{query}");
    (callbacks.on_auth)(&PrimeAuthInfo {
        url: auth_url,
        instructions: format!("Code: {}", challenge.challenge),
    });
    poll_prime_challenge_result(
        http,
        base_url,
        &challenge,
        &private_key,
        timeout_ms,
        poll_interval_ms,
    )
    .await
}

/// TS `loginPrimeAgentTraces`: the prime-cli credential reuse (only when
/// the traces base URL stays production), then the browser challenge, and
/// the final `agent_traces` access check on the returned key.
pub async fn login_prime_agent_traces(
    http: &dyn PrimeHttp,
    options: &PrimeAgentTracesLoginOptions<'_>,
    callbacks: &PrimeAgentTracesCallbacks<'_>,
) -> Result<(String, PrimeAgentTracesLoginSource), String> {
    let (trace_base_url, frontend_url) = resolve_prime_agent_traces_challenge_config();
    let request_timeout_ms = options
        .request_timeout_ms
        .unwrap_or(DEFAULT_REQUEST_TIMEOUT_MS);
    let poll_interval_ms = options.poll_interval_ms.unwrap_or(DEFAULT_POLL_INTERVAL_MS);
    let candidate = if options.use_prime_cli_config && trace_base_url == DEFAULT_PRIME_API_BASE_URL
    {
        options
            .prime_cli_config_path
            .and_then(read_prime_cli_config)
    } else {
        None
    };
    if let Some(api_key) = candidate.and_then(|config| config.api_key) {
        callbacks.progress("Checking existing Prime CLI credentials...");
        match check_prime_agent_traces_access(
            http,
            DEFAULT_PRIME_API_BASE_URL,
            &api_key,
            request_timeout_ms,
        )
        .await
        {
            Ok(()) => return Ok((api_key, PrimeAgentTracesLoginSource::PrimeCli)),
            Err(PrimeAccessError::Denied(failure)) => callbacks.progress(&format!(
                "Existing Prime CLI key cannot upload Prime Agent traces ({}). Starting browser login...",
                failure.format()
            )),
            Err(PrimeAccessError::Failed(message)) => return Err(message),
        }
    } else {
        callbacks.progress("No Prime CLI API key found. Starting browser login...");
    }
    let api_key = run_prime_browser_login(
        http,
        &trace_base_url,
        &frontend_url,
        callbacks,
        request_timeout_ms,
        poll_interval_ms,
    )
    .await?;
    callbacks.progress("Checking Prime Agent trace access...");
    match check_prime_agent_traces_access(http, &trace_base_url, &api_key, request_timeout_ms).await
    {
        Ok(()) => Ok((api_key, PrimeAgentTracesLoginSource::Browser)),
        Err(PrimeAccessError::Denied(failure)) => Err(format!(
            "Prime API key does not have Prime Agent trace access ({})",
            failure.format()
        )),
        Err(PrimeAccessError::Failed(message)) => Err(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rsa::pkcs8::DecodePublicKey;
    use std::collections::VecDeque;
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    type PrimeHttpResponse = super::super::prime_inference::PrimeHttpResponse;

    /// A scripted transport: exact URL -> response, in call order; the
    /// served requests land in the log. With `dynamic_generate` (the
    /// default) the generate POST answers with a fixed challenge and the
    /// status poll answers pending once, then the encrypted fixture key
    /// (so the flow's poll interval genuinely yields mid-flow).
    struct ScriptedHttp {
        queue: Mutex<VecDeque<(String, u16, String)>>,
        dynamic_generate: bool,
        dynamic_status: Mutex<Option<String>>,
        status_pending_once: AtomicBool,
        served: Mutex<Vec<String>>,
    }

    impl ScriptedHttp {
        fn new(responses: Vec<(&str, u16, &str)>) -> Self {
            ScriptedHttp {
                queue: Mutex::new(
                    responses
                        .into_iter()
                        .map(|(url, status, body)| (url.to_string(), status, body.to_string()))
                        .collect(),
                ),
                dynamic_generate: true,
                dynamic_status: Mutex::new(None),
                status_pending_once: AtomicBool::new(true),
                served: Mutex::new(Vec::new()),
            }
        }

        fn without_dynamic(responses: Vec<(&str, u16, &str)>) -> Self {
            let mut scripted = Self::new(responses);
            scripted.dynamic_generate = false;
            scripted
        }

        fn requests(&self) -> Vec<String> {
            self.served.lock().unwrap().clone()
        }

        fn pop(&self, url: &str) -> Option<(u16, String)> {
            let mut queue = self.queue.lock().unwrap();
            let position = queue.iter().position(|(expected, _, _)| expected == url)?;
            let (_, status, body) = queue
                .remove(position)
                .expect("the scripted response was queued");
            Some((status, body))
        }
    }

    impl PrimeHttp for ScriptedHttp {
        fn get(
            &self,
            url: &str,
            _api_key: &str,
            _timeout_ms: u64,
        ) -> Pin<Box<dyn Future<Output = Result<PrimeHttpResponse, String>> + Send>> {
            // The trait's boxed answer is 'static, so the whole read
            // resolves before the future arms.
            let url = url.to_string();
            self.served.lock().unwrap().push(url.clone());
            // The cipher stays until the pending answer has been served:
            // only the result response consumes it.
            let dynamic = self.dynamic_status.lock().unwrap().clone();
            let answer = if url.contains("/api/v1/auth_challenge/status") && dynamic.is_some() {
                if self.status_pending_once.swap(false, Ordering::SeqCst) {
                    // The first poll answers pending (the flow sleeps its
                    // poll interval and yields).
                    Ok(PrimeHttpResponse {
                        status: 200,
                        body: r#"{"pending":true}"#.to_string(),
                    })
                } else {
                    let cipher = self.dynamic_status.lock().unwrap().take();
                    Ok(PrimeHttpResponse {
                        status: 200,
                        body: format!(r#"{{"result":"{}"}}"#, cipher.unwrap_or_default()),
                    })
                }
            } else {
                match self.pop(&url) {
                    Some((status, body)) => Ok(PrimeHttpResponse { status, body }),
                    None => panic!("no scripted response for {url}"),
                }
            };
            Box::pin(async move { answer })
        }

        fn post_json<'a>(
            &'a self,
            url: &'a str,
            body: &'a str,
            _bearer: Option<&'a str>,
            _timeout_ms: u64,
        ) -> Pin<Box<dyn Future<Output = Result<PrimeHttpResponse, String>> + Send + 'a>> {
            let url = url.to_string();
            let body = body.to_string();
            self.served.lock().unwrap().push(url.clone());
            Box::pin(async move {
                if self.dynamic_generate && url.ends_with("/api/v1/auth_challenge/generate") {
                    // Capture the flow's public key so the status poll
                    // can encrypt the fixture key with it.
                    let parsed: Value = serde_json::from_str(&body).expect("generate body");
                    let public_pem = parsed
                        .get("encryptionPublicKey")
                        .and_then(Value::as_str)
                        .expect("public key")
                        .to_string();
                    let mut rng = rsa::rand_core::OsRng;
                    let public_key =
                        rsa::RsaPublicKey::from_public_key_pem(&public_pem).expect("public pem");
                    let cipher = public_key
                        .encrypt(
                            &mut rng,
                            rsa::Oaep::new::<sha2::Sha256>(),
                            b"fixture-browser-key",
                        )
                        .expect("encrypt");
                    let encoded = base64::engine::general_purpose::STANDARD.encode(cipher);
                    *self.dynamic_status.lock().unwrap() = Some(encoded);
                    return Ok(PrimeHttpResponse {
                        status: 200,
                        body: r#"{"challenge":"ch-1","status_auth_token":"tok"}"#.to_string(),
                    });
                }
                match self.pop(&url) {
                    Some((status, body)) => Ok(PrimeHttpResponse { status, body }),
                    None => panic!("no scripted response for {url}"),
                }
            })
        }
    }

    fn whoami_ok(scope_write: bool) -> (&'static str, u16, &'static str) {
        let body = if scope_write {
            r#"{"data":{"scope":{"agent_traces":{"write":true}}}}"#
        } else {
            r#"{"data":{"scope":{"agent_traces":{"write":false}}}}"#
        };
        (
            "https://api.primeintellect.ai/api/v1/user/whoami",
            200,
            body,
        )
    }

    /// The engine reads process env (the base-URL override); the tests
    /// that touch it serialize on one lock.
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn fast_options<'a>(
        prime_cli_config_path: Option<&'a std::path::Path>,
    ) -> PrimeAgentTracesLoginOptions<'a> {
        let mut options = PrimeAgentTracesLoginOptions::new(prime_cli_config_path);
        // The pending status poll's interval stays real: keep it short so
        // the tests yield without waiting the product's 5s window.
        options.poll_interval_ms = Some(10);
        options
    }

    #[tokio::test]
    async fn the_agent_traces_scope_check_names_the_ts_messages() {
        let http = ScriptedHttp::new(vec![whoami_ok(true)]);
        assert!(check_prime_agent_traces_access(
            &http,
            DEFAULT_PRIME_API_BASE_URL,
            "key",
            DEFAULT_REQUEST_TIMEOUT_MS
        )
        .await
        .is_ok());
        // The write permission is the gate.
        let denied = ScriptedHttp::new(vec![whoami_ok(false)]);
        match check_prime_agent_traces_access(
            &denied,
            DEFAULT_PRIME_API_BASE_URL,
            "key",
            DEFAULT_REQUEST_TIMEOUT_MS,
        )
        .await
        {
            Err(PrimeAccessError::Denied(failure)) => {
                assert_eq!(
                    failure.message,
                    "Prime token does not have agent trace write permission"
                );
            }
            other => panic!("expected a denial, got {other:?}"),
        }
        // The scope data must exist.
        let missing = ScriptedHttp::new(vec![(
            "https://api.primeintellect.ai/api/v1/user/whoami",
            200,
            r#"{"data":{"scope":{}}}"#,
        )]);
        match check_prime_agent_traces_access(
            &missing,
            DEFAULT_PRIME_API_BASE_URL,
            "key",
            DEFAULT_REQUEST_TIMEOUT_MS,
        )
        .await
        {
            Err(PrimeAccessError::Denied(failure)) => {
                assert_eq!(
                    failure.message,
                    "Prime token is missing agent trace permissions"
                );
            }
            other => panic!("expected a denial, got {other:?}"),
        }
    }

    #[tokio::test]
    // The process env must stay stable across the flow's awaits:
    // the sync env lock is held for the whole test by design.
    #[allow(clippy::await_holding_lock)]
    async fn the_login_reuses_an_eligible_prime_cli_key() {
        let _env = env_lock();
        std::env::remove_var("PRIME_AGENT_TRACES_BASE_URL");
        let dir = tempfile::tempdir().expect("temp dir");
        let config_path = dir.path().join("config.json");
        std::fs::write(
            &config_path,
            r#"{"api_key":"cli-key","base_url":"https://api.primeintellect.ai"}"#,
        )
        .expect("config");
        let http = ScriptedHttp::new(vec![whoami_ok(true)]);
        let logged = Mutex::new(Vec::<String>::new());
        let callbacks = PrimeAgentTracesCallbacks {
            on_auth: &|_| panic!("the cli path never shows a URL"),
            on_progress: Some(&|message: &str| {
                logged.lock().unwrap().push(message.to_string());
            }),
        };
        let options = fast_options(Some(&config_path));
        let (key, source) = login_prime_agent_traces(&http, &options, &callbacks)
            .await
            .expect("login");
        assert_eq!(key, "cli-key");
        assert_eq!(source, PrimeAgentTracesLoginSource::PrimeCli);
        assert_eq!(
            logged.lock().unwrap()[..],
            ["Checking existing Prime CLI credentials...".to_string()]
        );
    }

    #[tokio::test]
    // The process env must stay stable across the flow's awaits:
    // the sync env lock is held for the whole test by design.
    #[allow(clippy::await_holding_lock)]
    async fn the_browser_login_completes_the_challenge_round_trip() {
        let _env = env_lock();
        std::env::remove_var("PRIME_AGENT_TRACES_BASE_URL");
        let http = ScriptedHttp::new(vec![whoami_ok(true)]);
        let auth = Mutex::new(Vec::<String>::new());
        let logged = Mutex::new(Vec::<String>::new());
        let callbacks = PrimeAgentTracesCallbacks {
            on_auth: &|info: &PrimeAuthInfo| {
                auth.lock()
                    .unwrap()
                    .push(format!("{}\n{}", info.url, info.instructions));
            },
            on_progress: Some(&|message: &str| {
                logged.lock().unwrap().push(message.to_string());
            }),
        };
        let options = fast_options(None);
        let (key, source) = login_prime_agent_traces(&http, &options, &callbacks)
            .await
            .expect("login");
        assert_eq!(key, "fixture-browser-key");
        assert_eq!(source, PrimeAgentTracesLoginSource::Browser);
        // The auth URL carries the challenge code and the traces scope,
        // with the code line next to it.
        let shown = auth.lock().unwrap().join("\n");
        assert!(
            shown.contains(
                "https://app.primeintellect.ai/dashboard/tokens/challenge?code=ch-1&scope=agent_traces"
            ),
            "{shown}"
        );
        assert!(shown.contains("Code: ch-1"), "{shown}");
        // The progress lines match the TS arms.
        assert_eq!(
            logged.lock().unwrap()[..],
            [
                "No Prime CLI API key found. Starting browser login...".to_string(),
                "Checking Prime Agent trace access...".to_string(),
            ]
        );
        // The protocol sequence: generate, status (pending), status
        // (result), whoami.
        assert_eq!(
            http.requests(),
            vec![
                "https://api.primeintellect.ai/api/v1/auth_challenge/generate".to_string(),
                "https://api.primeintellect.ai/api/v1/auth_challenge/status?challenge=ch-1"
                    .to_string(),
                "https://api.primeintellect.ai/api/v1/auth_challenge/status?challenge=ch-1"
                    .to_string(),
                "https://api.primeintellect.ai/api/v1/user/whoami".to_string(),
            ]
        );
    }

    #[tokio::test]
    // The process env must stay stable across the flow's awaits:
    // the sync env lock is held for the whole test by design.
    #[allow(clippy::await_holding_lock)]
    async fn the_browser_key_without_traces_access_reports_the_ts_error() {
        let _env = env_lock();
        std::env::remove_var("PRIME_AGENT_TRACES_BASE_URL");
        let http = ScriptedHttp::new(vec![whoami_ok(false)]);
        let logged = Mutex::new(Vec::<String>::new());
        let callbacks = PrimeAgentTracesCallbacks {
            on_auth: &|_| {},
            on_progress: Some(&|message: &str| {
                logged.lock().unwrap().push(message.to_string());
            }),
        };
        let options = fast_options(None);
        match login_prime_agent_traces(&http, &options, &callbacks).await {
            Err(error) => assert_eq!(
                error,
                "Prime API key does not have Prime Agent trace access (Prime token does not have agent trace write permission)"
            ),
            Ok((key, source)) => panic!("expected a denial, got {key} ({source:?})"),
        }
    }

    #[tokio::test]
    // The process env must stay stable across the flow's awaits:
    // the sync env lock is held for the whole test by design.
    #[allow(clippy::await_holding_lock)]
    async fn an_ineligible_cli_key_falls_through_to_the_browser() {
        let _env = env_lock();
        std::env::remove_var("PRIME_AGENT_TRACES_BASE_URL");
        let dir = tempfile::tempdir().expect("temp dir");
        let config_path = dir.path().join("config.json");
        std::fs::write(
            &config_path,
            r#"{"api_key":"cli-key","base_url":"https://api.primeintellect.ai"}"#,
        )
        .expect("config");
        // The cli key lacks trace access; the browser key passes.
        let http = ScriptedHttp::new(vec![whoami_ok(false), whoami_ok(true)]);
        let logged = Mutex::new(Vec::<String>::new());
        let callbacks = PrimeAgentTracesCallbacks {
            on_auth: &|_| {},
            on_progress: Some(&|message: &str| {
                logged.lock().unwrap().push(message.to_string());
            }),
        };
        let options = fast_options(Some(&config_path));
        let (key, source) = login_prime_agent_traces(&http, &options, &callbacks)
            .await
            .expect("login");
        assert_eq!(key, "fixture-browser-key");
        assert_eq!(source, PrimeAgentTracesLoginSource::Browser);
        assert_eq!(
            logged.lock().unwrap()[0],
            "Checking existing Prime CLI credentials..."
        );
        assert!(logged.lock().unwrap()[1]
            .starts_with("Existing Prime CLI key cannot upload Prime Agent traces ("));
    }

    #[tokio::test]
    // The process env must stay stable across the flow's awaits:
    // the sync env lock is held for the whole test by design.
    #[allow(clippy::await_holding_lock)]
    async fn an_expired_challenge_reports_the_ts_error() {
        let _env = env_lock();
        std::env::remove_var("PRIME_AGENT_TRACES_BASE_URL");
        // A queued challenge round whose status poll expired: the
        // dynamic generate stays off so the queue owns every answer.
        let http = ScriptedHttp::without_dynamic(vec![
            (
                "https://api.primeintellect.ai/api/v1/auth_challenge/generate",
                200,
                r#"{"challenge":"ch-1","status_auth_token":"tok"}"#,
            ),
            (
                "https://api.primeintellect.ai/api/v1/auth_challenge/status?challenge=ch-1",
                404,
                "",
            ),
        ]);
        let callbacks = PrimeAgentTracesCallbacks {
            on_auth: &|_| {},
            on_progress: None,
        };
        let options = PrimeAgentTracesLoginOptions {
            prime_cli_config_path: None,
            use_prime_cli_config: false,
            poll_interval_ms: Some(0),
            request_timeout_ms: Some(DEFAULT_REQUEST_TIMEOUT_MS),
        };
        match login_prime_agent_traces(&http, &options, &callbacks).await {
            Err(error) => assert_eq!(error, "Prime login challenge expired"),
            Ok((key, _)) => panic!("expected an expiry, got {key}"),
        }
    }

    #[test]
    fn the_traces_base_url_resolves_the_override_or_the_default() {
        assert_eq!(
            resolve_prime_agent_traces_base_url(None),
            DEFAULT_PRIME_API_BASE_URL
        );
        assert_eq!(
            resolve_prime_agent_traces_base_url(Some("https://api.example/api/v1/")),
            "https://api.example"
        );
    }
}
