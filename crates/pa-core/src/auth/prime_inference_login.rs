//! Prime Inference login orchestration (TS `prime-inference-auth.ts`'s
//! `loginPrimeInference`): the production prime-cli credential reuse, the
//! browser challenge over the arm-agnostic core the traces login owns
//! (`prime_traces.rs`'s `run_prime_browser_login` — no scope on the URL),
//! and the inference access check on the resulting key. The interactive
//! surface (the URL raced against the paste prompt, the fallback, the
//! cancellation) is the composition root's (`pa-cli`'s
//! `prime_inference_login.rs`); the API-key surface (the whoami check, the
//! team list, the cli config) is `prime_inference.rs`'s.

use std::path::Path;

use super::prime_inference::{
    check_prime_inference_access, read_prime_cli_config, PrimeAccessError, PrimeHttp,
    PrimeInferenceAuthConfig, DEFAULT_PRIME_API_BASE_URL, DEFAULT_PRIME_FRONTEND_URL,
    DEFAULT_REQUEST_TIMEOUT_MS,
};
use super::prime_traces::{run_prime_browser_login, PrimeAuthInfo, DEFAULT_POLL_INTERVAL_MS};
use super::types::PrimeTeamAssignment;

/// TS `PrimeInferenceLoginResult`'s `source` (`"prime-cli" | "browser"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrimeInferenceLoginSource {
    PrimeCli,
    Browser,
}

/// TS `PrimeInferenceLoginResult`: the key, where it came from, and the
/// team the credential write carries.
#[derive(Debug, Clone, PartialEq)]
pub struct PrimeInferenceLoginResult {
    pub api_key: String,
    pub source: PrimeInferenceLoginSource,
    /// TS the result's `primeTeam`: the cli candidate's team, `null` for
    /// its personal account, and absent for the browser arm — the
    /// [`PrimeTeamAssignment`] encoding of that tri-state.
    pub prime_team: PrimeTeamAssignment,
}

/// The login's callbacks (TS `PrimeInferenceLoginCallbacks`): the auth
/// surface (the browser URL with its code line) and the progress line.
pub struct PrimeInferenceLoginCallbacks<'a> {
    pub on_auth: &'a (dyn Fn(&PrimeAuthInfo) + Send + Sync),
    pub on_progress: Option<&'a (dyn Fn(&str) + Send + Sync)>,
}

impl PrimeInferenceLoginCallbacks<'_> {
    /// TS the optional `onProgress` arm.
    fn progress(&self, message: &str) {
        if let Some(on_progress) = self.on_progress {
            on_progress(message);
        }
    }
}

/// TS `PrimeInferenceLoginOptions`: the prime-cli reuse and the poll and
/// request timing.
pub struct PrimeInferenceLoginOptions<'a> {
    pub prime_cli_config_path: Option<&'a Path>,
    pub use_prime_cli_config: bool,
    pub poll_interval_ms: Option<u64>,
    pub request_timeout_ms: Option<u64>,
}

impl<'a> PrimeInferenceLoginOptions<'a> {
    /// TS the default options object (`{}`): the prime-cli reuse is on,
    /// the path and the timing come from the caller's inputs.
    pub fn new(prime_cli_config_path: Option<&'a Path>) -> Self {
        PrimeInferenceLoginOptions {
            prime_cli_config_path,
            use_prime_cli_config: prime_cli_config_path.is_some(),
            poll_interval_ms: None,
            request_timeout_ms: None,
        }
    }
}

/// TS `loginPrimeInference`: the whole login — the production prime-cli
/// credential reuse first, then the browser challenge (its URL carries
/// only the code), then the inference access check on the resulting key.
/// The config arrives resolved (TS resolves it inside; the composition
/// root resolves once so the whole interactive flow shares it). TS's
/// `signal` cancellation is the caller's drop here: the composition root
/// drops this future to stop the status poll mid-flight.
///
/// # Errors
///
/// Returns a human-readable error string when the reused prime-cli key's
/// access check fails to run, when the browser challenge or its polling
/// fails, or when the resulting key does not have Prime Inference access.
pub async fn login_prime_inference(
    http: &dyn PrimeHttp,
    config: &PrimeInferenceAuthConfig,
    options: &PrimeInferenceLoginOptions<'_>,
    callbacks: &PrimeInferenceLoginCallbacks<'_>,
) -> Result<PrimeInferenceLoginResult, String> {
    let request_timeout_ms = options
        .request_timeout_ms
        .unwrap_or(DEFAULT_REQUEST_TIMEOUT_MS);
    let poll_interval_ms = options.poll_interval_ms.unwrap_or(DEFAULT_POLL_INTERVAL_MS);
    // TS `loginPrimeInference`'s candidate rule: the prime CLI's
    // credential is reused only when both URLs stay production.
    let candidate = if options.use_prime_cli_config && config.is_production() {
        options
            .prime_cli_config_path
            .and_then(read_prime_cli_config)
    } else {
        None
    };
    if let Some(api_key) = candidate
        .as_ref()
        .and_then(|candidate| candidate.api_key.as_deref())
    {
        callbacks.progress("Checking existing Prime CLI credentials...");
        match check_prime_inference_access(http, &config.base_url, api_key, request_timeout_ms)
            .await
        {
            Ok(()) => {
                let api_key = api_key.to_string();
                // TS `importedPrimeTeam`: the candidate's team rides the
                // key; no team is the personal account.
                let prime_team = match candidate.and_then(|candidate| candidate.team) {
                    Some(team) => PrimeTeamAssignment::Team(team),
                    None => PrimeTeamAssignment::PersonalAccount,
                };
                return Ok(PrimeInferenceLoginResult {
                    api_key,
                    source: PrimeInferenceLoginSource::PrimeCli,
                    prime_team,
                });
            }
            // TS continues to the browser login with this line.
            Err(PrimeAccessError::Denied(failure)) => callbacks.progress(&format!(
                "Existing Prime CLI key cannot access Prime Inference ({}). Starting browser login...",
                failure.format()
            )),
            Err(PrimeAccessError::Failed(message)) => return Err(message),
        }
    } else {
        callbacks
            .progress("No eligible production Prime CLI API key found. Starting browser login...");
    }
    // TS `runPrimeBrowserLogin` without a scope: the inference
    // challenge's URL carries only the code.
    let api_key = run_prime_browser_login(
        http,
        &config.base_url,
        &config.frontend_url,
        None,
        callbacks.on_auth,
        request_timeout_ms,
        poll_interval_ms,
    )
    .await?;
    callbacks.progress("Checking Prime Inference access...");
    match check_prime_inference_access(http, &config.base_url, &api_key, request_timeout_ms).await {
        Ok(()) => Ok(PrimeInferenceLoginResult {
            api_key,
            source: PrimeInferenceLoginSource::Browser,
            // TS the browser result carries no `primeTeam`: the stored
            // selection of the same key survives the credential write.
            prime_team: PrimeTeamAssignment::PreserveWhenKeyMatches,
        }),
        Err(PrimeAccessError::Denied(failure)) => Err(format!(
            "Prime API key does not have Prime Inference access ({})",
            failure.format()
        )),
        Err(PrimeAccessError::Failed(message)) => Err(message),
    }
}

#[cfg(test)]
mod tests {
    use super::super::types::PrimeTeamCredential;
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
                    let parsed: serde_json::Value =
                        serde_json::from_str(&body).expect("generate body");
                    let public_pem = parsed
                        .get("encryptionPublicKey")
                        .and_then(serde_json::Value::as_str)
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

    /// The production challenge config (the scripted transport keeps the
    /// requests hermetic).
    fn production_config() -> PrimeInferenceAuthConfig {
        PrimeInferenceAuthConfig {
            base_url: DEFAULT_PRIME_API_BASE_URL.to_string(),
            frontend_url: DEFAULT_PRIME_FRONTEND_URL.to_string(),
        }
    }

    fn whoami_ok(scope_write: bool) -> (&'static str, u16, &'static str) {
        let body = if scope_write {
            r#"{"data":{"scope":{"inference":{"write":true}}}}"#
        } else {
            r#"{"data":{"scope":{"inference":{"write":false}}}}"#
        };
        (
            "https://api.primeintellect.ai/api/v1/user/whoami",
            200,
            body,
        )
    }

    /// The fast options: the pending status poll's interval stays real but
    /// short, so the tests yield without the product's 5s window.
    fn fast_options<'a>(
        prime_cli_config_path: Option<&'a std::path::Path>,
    ) -> PrimeInferenceLoginOptions<'a> {
        let mut options = PrimeInferenceLoginOptions::new(prime_cli_config_path);
        options.poll_interval_ms = Some(10);
        options
    }

    #[tokio::test]
    async fn the_prime_cli_candidate_short_circuits_with_its_team() {
        let dir = tempfile::tempdir().expect("temp dir");
        let config_path = dir.path().join("config.json");
        std::fs::write(
            &config_path,
            r#"{"api_key":"cli-key","team_id":"t-1","team_name":"One"}"#,
        )
        .expect("config");
        let http = ScriptedHttp::new(vec![whoami_ok(true)]);
        let progress = Mutex::new(Vec::<String>::new());
        let callbacks = PrimeInferenceLoginCallbacks {
            on_auth: &|_| panic!("the cli path never shows a URL"),
            on_progress: Some(&|message: &str| {
                progress.lock().unwrap().push(message.to_string());
            }),
        };
        let result = login_prime_inference(
            &http,
            &production_config(),
            &fast_options(Some(&config_path)),
            &callbacks,
        )
        .await
        .expect("login");
        assert_eq!(
            result,
            PrimeInferenceLoginResult {
                api_key: "cli-key".to_string(),
                source: PrimeInferenceLoginSource::PrimeCli,
                prime_team: PrimeTeamAssignment::Team(PrimeTeamCredential {
                    team_id: "t-1".to_string(),
                    name: "One".to_string(),
                    slug: None,
                    role: None,
                    created_at: None,
                }),
            }
        );
        assert_eq!(
            progress.lock().unwrap()[..],
            ["Checking existing Prime CLI credentials...".to_string()]
        );
        // Only the cli key's whoami ran.
        assert_eq!(
            http.requests(),
            vec!["https://api.primeintellect.ai/api/v1/user/whoami".to_string()]
        );
    }

    #[tokio::test]
    async fn the_prime_cli_candidate_without_a_team_is_the_personal_account() {
        let dir = tempfile::tempdir().expect("temp dir");
        let config_path = dir.path().join("config.json");
        std::fs::write(&config_path, r#"{"api_key":"cli-key"}"#).expect("config");
        let http = ScriptedHttp::new(vec![whoami_ok(true)]);
        let callbacks = PrimeInferenceLoginCallbacks {
            on_auth: &|_| panic!("the cli path never shows a URL"),
            on_progress: None,
        };
        let result = login_prime_inference(
            &http,
            &production_config(),
            &fast_options(Some(&config_path)),
            &callbacks,
        )
        .await
        .expect("login");
        assert_eq!(result.prime_team, PrimeTeamAssignment::PersonalAccount);
    }

    #[tokio::test]
    async fn a_denied_cli_key_runs_the_browser_challenge() {
        let dir = tempfile::tempdir().expect("temp dir");
        let config_path = dir.path().join("config.json");
        std::fs::write(&config_path, r#"{"api_key":"cli-key"}"#).expect("config");
        // The cli key is denied; the browser key passes.
        let http = ScriptedHttp::new(vec![
            (
                "https://api.primeintellect.ai/api/v1/user/whoami",
                403,
                r#"{"error":{"message":"denied"}}"#,
            ),
            whoami_ok(true),
        ]);
        let progress = Mutex::new(Vec::<String>::new());
        let auth = Mutex::new(Vec::<String>::new());
        let callbacks = PrimeInferenceLoginCallbacks {
            on_auth: &|info: &PrimeAuthInfo| {
                auth.lock()
                    .unwrap()
                    .push(format!("{}\n{}", info.url, info.instructions));
            },
            on_progress: Some(&|message: &str| {
                progress.lock().unwrap().push(message.to_string());
            }),
        };
        let result = login_prime_inference(
            &http,
            &production_config(),
            &fast_options(Some(&config_path)),
            &callbacks,
        )
        .await
        .expect("login");
        assert_eq!(
            result,
            PrimeInferenceLoginResult {
                api_key: "fixture-browser-key".to_string(),
                source: PrimeInferenceLoginSource::Browser,
                prime_team: PrimeTeamAssignment::PreserveWhenKeyMatches,
            }
        );
        assert_eq!(
            progress.lock().unwrap()[..],
            [
                "Checking existing Prime CLI credentials...".to_string(),
                "Existing Prime CLI key cannot access Prime Inference (HTTP 403: denied). Starting browser login..."
                    .to_string(),
                "Checking Prime Inference access...".to_string(),
            ]
        );
        // The protocol sequence: the cli whoami, then the challenge round
        // trip, then the browser key's whoami.
        assert_eq!(
            http.requests(),
            vec![
                "https://api.primeintellect.ai/api/v1/user/whoami".to_string(),
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
    async fn the_browser_challenge_url_carries_only_the_code() {
        let http = ScriptedHttp::new(vec![whoami_ok(true)]);
        let progress = Mutex::new(Vec::<String>::new());
        let auth = Mutex::new(Vec::<String>::new());
        let callbacks = PrimeInferenceLoginCallbacks {
            on_auth: &|info: &PrimeAuthInfo| {
                auth.lock()
                    .unwrap()
                    .push(format!("{}\n{}", info.url, info.instructions));
            },
            on_progress: Some(&|message: &str| {
                progress.lock().unwrap().push(message.to_string());
            }),
        };
        let result =
            login_prime_inference(&http, &production_config(), &fast_options(None), &callbacks)
                .await
                .expect("login");
        assert_eq!(result.source, PrimeInferenceLoginSource::Browser);
        // TS sends no scope for the inference arm: the URL keeps only the
        // code, with the code line next to it.
        assert_eq!(
            auth.lock().unwrap().join("\n"),
            "https://app.primeintellect.ai/dashboard/tokens/challenge?code=ch-1\nCode: ch-1"
        );
        assert_eq!(
            progress.lock().unwrap()[..],
            [
                "No eligible production Prime CLI API key found. Starting browser login..."
                    .to_string(),
                "Checking Prime Inference access...".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn a_non_production_config_never_reads_the_prime_cli() {
        let dir = tempfile::tempdir().expect("temp dir");
        // A cli config carries a working key, but the challenge config's
        // base URL is overridden: the reuse is production-only.
        let config_path = dir.path().join("config.json");
        std::fs::write(&config_path, r#"{"api_key":"cli-key"}"#).expect("config");
        let config = PrimeInferenceAuthConfig {
            base_url: "https://api.example".to_string(),
            frontend_url: DEFAULT_PRIME_FRONTEND_URL.to_string(),
        };
        let http = ScriptedHttp::new(vec![(
            "https://api.example/api/v1/user/whoami",
            200,
            r#"{"data":{"scope":{"inference":{"write":true}}}}"#,
        )]);
        let progress = Mutex::new(Vec::<String>::new());
        let callbacks = PrimeInferenceLoginCallbacks {
            on_auth: &|_| {},
            on_progress: Some(&|message: &str| {
                progress.lock().unwrap().push(message.to_string());
            }),
        };
        let result = login_prime_inference(
            &http,
            &config,
            &fast_options(Some(&config_path)),
            &callbacks,
        )
        .await
        .expect("login");
        assert_eq!(result.source, PrimeInferenceLoginSource::Browser);
        // No cli whoami ran: the challenge and its check hit the override.
        assert_eq!(
            progress.lock().unwrap()[..],
            [
                "No eligible production Prime CLI API key found. Starting browser login..."
                    .to_string(),
                "Checking Prime Inference access...".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn the_browser_key_without_inference_access_reports_the_ts_error() {
        let http = ScriptedHttp::new(vec![whoami_ok(false)]);
        let callbacks = PrimeInferenceLoginCallbacks {
            on_auth: &|_| {},
            on_progress: None,
        };
        match login_prime_inference(
            &http,
            &production_config(),
            &fast_options(None),
            &callbacks,
        )
        .await
        {
            Err(error) => assert_eq!(
                error,
                "Prime API key does not have Prime Inference access (Prime token does not have inference write permission)"
            ),
            Ok(result) => panic!("expected a denial, got {result:?}"),
        }
    }

    #[tokio::test]
    async fn an_expired_challenge_reports_the_ts_error() {
        // A queued challenge round whose status poll expired: the dynamic
        // generate stays off so the queue owns every answer.
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
        let callbacks = PrimeInferenceLoginCallbacks {
            on_auth: &|_| {},
            on_progress: None,
        };
        let options = PrimeInferenceLoginOptions {
            prime_cli_config_path: None,
            use_prime_cli_config: false,
            poll_interval_ms: Some(0),
            request_timeout_ms: Some(DEFAULT_REQUEST_TIMEOUT_MS),
        };
        match login_prime_inference(&http, &production_config(), &options, &callbacks).await {
            Err(error) => assert_eq!(error, "Prime login challenge expired"),
            Ok(result) => panic!("expected an expiry, got {result:?}"),
        }
    }
}
