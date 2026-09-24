//! The composition root's terminal Prime Agent Traces login (TS
//! `runPrimeAgentTracesLogin`): the prime-cli credential reuse, the RSA
//! browser challenge raced against the paste prompt (the TS dialog's
//! manual-key fallback), the `agent_traces` access check, and the
//! credential write. Runs with the terminal handed over (the TUI is
//! suspended around the call), so the progress lines and the paste
//! prompt own the plain terminal — the TS dialog's surfaces.
//!
//! The terminal race differs from the dialog in one way: a pasted line
//! read that the browser login overtakes is dropped, so a half-typed
//! paste can be lost (the TS field would keep it; the plain terminal
//! has no field to keep).

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::{pin, Pin};

use pa_core::agent_traces::resolve_traces_base_url;
use pa_core::auth::{
    check_prime_agent_traces_access, login_prime_agent_traces, AuthCredential, AuthStorage,
    PrimeAccessError, PrimeAgentTracesCallbacks, PrimeAgentTracesLoginOptions, PrimeAuthInfo,
    ReqwestPrimeHttp, DEFAULT_REQUEST_TIMEOUT_MS, PRIME_AGENT_TRACES_PROVIDER_ID,
    PRIME_AGENT_TRACES_PROVIDER_NAME,
};

use pa_tui::traces::TraceLoginOutcome;

/// TS `armManualInput`'s armed prompt after the browser URL shows.
const BROWSER_PROMPT: &str =
    "Complete the sign-in in your browser, or paste a Prime API key below:";
/// TS the browser-unavailable fallback's prompt.
const FALLBACK_PROMPT: &str = "Paste a Prime API key below:";

/// The login's terminal surface (the TS login dialog's surface): the
/// progress lines, the auth URL (with the browser open), and the paste
/// prompt. The seam keeps the flow scriptable in tests; `Send + Sync`
/// because the race's boxed arms are `Send`.
pub(crate) trait TracesLoginUi: Send + Sync {
    /// TS `onProgress` / `dialog.showProgress`.
    fn progress(&self, message: &str);
    /// TS `dialog.showAuth` (the URL + the code line) and the terminal
    /// port's browser open.
    fn on_auth(&self, url: &str, instructions: &str);
    /// One paste prompt (TS `armManualInput`): an empty line re-reads,
    /// `None` (the input surface went away) cancels the login.
    fn prompt_line(
        &self,
        prompt: &str,
    ) -> Pin<Box<dyn Future<Output = Option<String>> + Send + '_>>;
}

/// The login's resolved inputs: the store's agent dir, the transport,
/// and the prime-cli reuse candidate (TS `getPrimeCliConfigPath()`:
/// enabled only when the agent dir is the resolved default).
pub(crate) struct TracesLoginInputs<'a> {
    pub agent_dir: &'a Path,
    pub http: &'a dyn pa_core::auth::PrimeHttp,
    pub prime_cli_config_path: Option<&'a Path>,
    /// The challenge poll interval (the product's 5s default; tests use
    /// milliseconds to keep the browser-completes path short).
    pub poll_interval_ms: Option<u64>,
}

/// TS `runPrimeAgentTracesLogin`: the whole flow on the plain terminal
/// (the TUI is suspended around the call).
pub(crate) async fn run_traces_login(agent_dir: &Path) -> TraceLoginOutcome {
    let http = ReqwestPrimeHttp;
    let prime_cli_config_path: Option<PathBuf> = (agent_dir == crate::config::get_agent_dir())
        .then(pa_core::auth::default_prime_cli_config_path);
    let inputs = TracesLoginInputs {
        agent_dir,
        http: &http,
        prime_cli_config_path: prime_cli_config_path.as_deref(),
        poll_interval_ms: None,
    };
    run_traces_login_inner(&inputs, &TerminalTracesLoginUi).await
}

async fn run_traces_login_inner(
    inputs: &TracesLoginInputs<'_>,
    ui: &dyn TracesLoginUi,
) -> TraceLoginOutcome {
    let mut options = PrimeAgentTracesLoginOptions::new(inputs.prime_cli_config_path);
    options.poll_interval_ms = inputs.poll_interval_ms;
    // TS `armManualInput`: the paste prompt arms when the browser URL
    // shows, and again (under the fallback text) when the browser flow
    // fails before it does.
    let (arm_tx, mut arm_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let armed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let on_auth = {
        let armed = armed.clone();
        let arm_tx = arm_tx.clone();
        move |info: &PrimeAuthInfo| {
            ui.on_auth(&info.url, &info.instructions);
            if !armed.swap(true, std::sync::atomic::Ordering::SeqCst) {
                let _ = arm_tx.send(BROWSER_PROMPT.to_string());
            }
        }
    };
    let on_progress = |message: &str| ui.progress(message);
    let callbacks = PrimeAgentTracesCallbacks {
        on_auth: &on_auth,
        on_progress: Some(&on_progress),
    };
    let mut login = pin!(login_prime_agent_traces(inputs.http, &options, &callbacks));
    // The local sender keeps the arm channel open for the fallback arm
    // (the login future's own sender dies with it).
    let _keep_arm_open = arm_tx;

    let mut manual: Option<Pin<Box<dyn Future<Output = Option<String>> + Send + '_>>> = None;
    // Whether the arm signal has been consumed (the armed flag inside
    // the closure guards the double-send; this one gates the select arm).
    let mut arm_seen = false;
    let mut login_dead = false;
    loop {
        // TS `Promise.race([browserLoginOrFallback, manualKeyEntry,
        // dialogCancelled])`: whichever settles first wins; the loser is
        // dropped (the browser abort on a manual key, the paste read on
        // a browser key).
        enum Step {
            Login(Result<(String, pa_core::auth::PrimeAgentTracesLoginSource), String>),
            Armed,
            Manual(Option<String>),
        }
        let step = tokio::select! {
            result = &mut login, if !login_dead => Step::Login(result),
            _ = arm_rx.recv(), if !arm_seen => Step::Armed,
            line = async { manual.as_mut().expect("the manual read is armed").as_mut().await }, if manual.is_some() => Step::Manual(line),
        };
        match step {
            Step::Login(Ok((api_key, _source))) => return complete_login(inputs, &api_key),
            Step::Login(Err(error)) => {
                // TS the browser-unavailable fallback: keep the dialog
                // open and fall back to plain API key entry.
                login_dead = true;
                ui.progress(&format!("Browser sign-in unavailable ({error})."));
                if manual.is_none() {
                    arm_seen = true;
                    manual = Some(Box::pin(prompt_non_empty(ui, FALLBACK_PROMPT)));
                }
            }
            Step::Armed => {
                arm_seen = true;
                manual = Some(Box::pin(prompt_non_empty(ui, BROWSER_PROMPT)));
            }
            Step::Manual(line) => {
                let Some(api_key) = line else {
                    return TraceLoginOutcome::Cancelled;
                };
                // TS the manual path: stop the browser flow (the login
                // future above is dropped when this branch wins) and
                // check the pasted key's trace access.
                return manual_login(inputs, ui, &api_key).await;
            }
        }
    }
}

/// TS `armManualInput`'s loop: the prompt repeats until a non-empty line
/// arrives; a closed input cancels.
async fn prompt_non_empty(ui: &dyn TracesLoginUi, prompt: &str) -> Option<String> {
    loop {
        let line = ui.prompt_line(prompt).await?;
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
}

/// TS the manual-key path: `dialog.showProgress("Checking Prime Agent
/// trace access...")` + `checkPrimeAgentTracesAccess`, with the thrown
/// denial mapped to the flow's error row.
async fn manual_login(
    inputs: &TracesLoginInputs<'_>,
    ui: &dyn TracesLoginUi,
    api_key: &str,
) -> TraceLoginOutcome {
    ui.progress("Checking Prime Agent trace access...");
    match check_prime_agent_traces_access(
        inputs.http,
        &resolve_traces_base_url(None),
        api_key,
        DEFAULT_REQUEST_TIMEOUT_MS,
    )
    .await
    {
        Ok(()) => complete_login(inputs, api_key),
        Err(PrimeAccessError::Denied(failure)) => TraceLoginOutcome::Error(format!(
            "Failed to login to {}: Prime API key does not have Prime Agent trace access ({})",
            PRIME_AGENT_TRACES_PROVIDER_NAME,
            failure.format()
        )),
        Err(PrimeAccessError::Failed(message)) => TraceLoginOutcome::Error(format!(
            "Failed to login to {PRIME_AGENT_TRACES_PROVIDER_NAME}: {message}"
        )),
    }
}

/// TS `completePrimeAgentTracesLogin` + `completeProviderAuthentication`:
/// store the key and report the TS status row.
fn complete_login(inputs: &TracesLoginInputs<'_>, api_key: &str) -> TraceLoginOutcome {
    let mut auth = AuthStorage::create(inputs.agent_dir);
    auth.set(
        PRIME_AGENT_TRACES_PROVIDER_ID,
        AuthCredential::ApiKey {
            key: api_key.to_string(),
            prime_team: None,
        },
    );
    if let Some(error) = auth.drain_errors().pop() {
        return TraceLoginOutcome::Error(format!(
            "Failed to login to {PRIME_AGENT_TRACES_PROVIDER_NAME}: {error}"
        ));
    }
    TraceLoginOutcome::Status(format!(
        "Saved API key for {}. Credentials saved to {}",
        PRIME_AGENT_TRACES_PROVIDER_NAME,
        inputs.agent_dir.join("auth.json").display()
    ))
}

/// The terminal login surface while the TUI is suspended (the TS dialog's
/// surfaces on the plain terminal).
struct TerminalTracesLoginUi;

impl TracesLoginUi for TerminalTracesLoginUi {
    fn progress(&self, message: &str) {
        println!("{message}");
    }

    fn on_auth(&self, url: &str, instructions: &str) {
        println!("{instructions}");
        println!("{url}");
        println!();
        pa_core::platform::browser::open_in_browser(url);
    }

    fn prompt_line(
        &self,
        prompt: &str,
    ) -> Pin<Box<dyn Future<Output = Option<String>> + Send + '_>> {
        let prompt = prompt.to_string();
        Box::pin(async move {
            println!("{prompt}");
            read_terminal_line().await
        })
    }
}

/// One line off the plain terminal (the paste read must be cancellable:
/// the browser login overtaking it drops the read, exactly the TS abort
/// the dialog's paste field sees).
async fn read_terminal_line() -> Option<String> {
    use tokio::io::AsyncBufReadExt;
    let mut line = String::new();
    match tokio::io::BufReader::new(tokio::io::stdin())
        .read_line(&mut line)
        .await
    {
        Ok(0) | Err(_) => None,
        Ok(_) => Some(line.trim().to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rsa::pkcs8::DecodePublicKey;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    type PrimeHttpResponse = pa_core::auth::PrimeHttpResponse;

    /// A scripted transport: exact URL -> response, in call order; the
    /// served requests land in the log. With `dynamic_generate` (the
    /// default) the generate POST answers with a fixed challenge and the
    /// status poll answers pending once, then the encrypted fixture key —
    /// the flow's poll interval genuinely yields mid-flow, so the armed
    /// paste wins the race deterministically.
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

        fn pop(&self, url: &str) -> Option<(u16, String)> {
            let mut queue = self.queue.lock().unwrap();
            let position = queue.iter().position(|(expected, _, _)| expected == url)?;
            let (_, status, body) = queue
                .remove(position)
                .expect("the scripted response was queued");
            Some((status, body))
        }
    }

    impl pa_core::auth::PrimeHttp for ScriptedHttp {
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
                    let parsed: serde_json::Value =
                        serde_json::from_str(&body).expect("the generate body is JSON");
                    let public_pem = parsed
                        .get("encryptionPublicKey")
                        .and_then(serde_json::Value::as_str)
                        .expect("the generate body carries the public key")
                        .to_string();
                    let mut rng = rsa::rand_core::OsRng;
                    let public_key =
                        rsa::RsaPublicKey::from_public_key_pem(&public_pem).expect("pem");
                    let cipher = public_key
                        .encrypt(
                            &mut rng,
                            rsa::Oaep::new::<sha2::Sha256>(),
                            b"fixture-browser-key",
                        )
                        .expect("encrypt");
                    let encoded =
                        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, cipher);
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

    /// A scripted UI: the queued paste answers arrive in order (a `None`
    /// closes the input); progress lines and the auth URL land in the
    /// log. `wait_forever` holds the paste unanswered (the browser login
    /// completes instead).
    struct ScriptedUi {
        progress: Mutex<Vec<String>>,
        auth: Mutex<Vec<String>>,
        pastes: Mutex<VecDeque<Option<String>>>,
        prompt_seen: Mutex<Vec<String>>,
        wait_forever: AtomicBool,
    }

    impl ScriptedUi {
        fn new(pastes: Vec<Option<String>>) -> Self {
            ScriptedUi {
                progress: Mutex::new(Vec::new()),
                auth: Mutex::new(Vec::new()),
                pastes: Mutex::new(pastes.into_iter().collect()),
                prompt_seen: Mutex::new(Vec::new()),
                wait_forever: AtomicBool::new(false),
            }
        }

        fn logs(&self) -> (Vec<String>, Vec<String>, Vec<String>) {
            (
                self.progress.lock().unwrap().clone(),
                self.auth.lock().unwrap().clone(),
                self.prompt_seen.lock().unwrap().clone(),
            )
        }
    }

    impl TracesLoginUi for ScriptedUi {
        fn progress(&self, message: &str) {
            self.progress.lock().unwrap().push(message.to_string());
        }

        fn on_auth(&self, url: &str, instructions: &str) {
            self.auth
                .lock()
                .unwrap()
                .push(format!("{instructions}\n{url}"));
        }

        fn prompt_line(
            &self,
            prompt: &str,
        ) -> Pin<Box<dyn Future<Output = Option<String>> + Send + '_>> {
            self.prompt_seen.lock().unwrap().push(prompt.to_string());
            // The answer pops synchronously (a Mutex is not clonable into
            // the future).
            let answer = self
                .pastes
                .lock()
                .unwrap()
                .pop_front()
                .expect("a scripted paste is queued");
            let wait_forever = self.wait_forever.load(Ordering::SeqCst);
            Box::pin(async move {
                if wait_forever {
                    std::future::pending::<Option<String>>().await;
                    unreachable!("a pending paste never answers");
                }
                answer
            })
        }
    }

    fn whoami_ok() -> (&'static str, u16, &'static str) {
        (
            "https://api.primeintellect.ai/api/v1/user/whoami",
            200,
            r#"{"data":{"scope":{"agent_traces":{"write":true}}}}"#,
        )
    }

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn temp_agent() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent = dir.path().join("agent");
        std::fs::create_dir_all(&agent).expect("agent dir");
        (dir, agent)
    }

    #[tokio::test]
    // The process env must stay stable across the flow's awaits:
    // the sync env lock is held for the whole test by design.
    #[allow(clippy::await_holding_lock)]
    async fn the_cli_candidate_logs_in_without_a_prompt() {
        let _env = env_lock();
        std::env::remove_var("PRIME_AGENT_TRACES_BASE_URL");
        let (dir, agent) = temp_agent();
        let config = dir.path().join("prime-config.json");
        std::fs::write(
            &config,
            r#"{"api_key":"cli-key","base_url":"https://api.primeintellect.ai"}"#,
        )
        .expect("config");
        let http = ScriptedHttp::new(vec![whoami_ok()]);
        let ui = Arc::new(ScriptedUi::new(vec![]));
        let inputs = TracesLoginInputs {
            agent_dir: &agent,
            http: &http,
            prime_cli_config_path: Some(&config),
            poll_interval_ms: Some(10),
        };
        let outcome = run_traces_login_inner(&inputs, ui.as_ref()).await;
        assert_eq!(
            outcome,
            TraceLoginOutcome::Status(format!(
                "Saved API key for Prime Agent Traces. Credentials saved to {}",
                agent.join("auth.json").display()
            ))
        );
        let (progress, auth, prompts) = ui.logs();
        assert_eq!(
            progress,
            vec!["Checking existing Prime CLI credentials...".to_string()]
        );
        assert!(auth.is_empty(), "no browser URL on the cli path");
        assert!(prompts.is_empty(), "no paste prompt on the cli path");
        // The store holds the trace credential.
        let mut storage = AuthStorage::create(&agent);
        assert_eq!(
            storage
                .get_api_key_with_source_token("prime-agent-traces", false)
                .api_key,
            Some("cli-key".to_string())
        );
    }

    #[tokio::test]
    // The process env must stay stable across the flow's awaits:
    // the sync env lock is held for the whole test by design.
    #[allow(clippy::await_holding_lock)]
    async fn the_manual_key_wins_the_race_and_checks_access() {
        let _env = env_lock();
        std::env::remove_var("PRIME_AGENT_TRACES_BASE_URL");
        let (_dir, agent) = temp_agent();
        // The browser flow starts (the generate answer arms the prompt),
        // the pending status poll yields, and the pasted key wins.
        let http = ScriptedHttp::new(vec![whoami_ok()]);
        let ui = ScriptedUi::new(vec![Some("manual-key".to_string()), None]);
        let ui = Arc::new(ui);
        let inputs = TracesLoginInputs {
            agent_dir: &agent,
            http: &http,
            prime_cli_config_path: None,
            poll_interval_ms: None,
        };
        let outcome = run_traces_login_inner(&inputs, ui.as_ref()).await;
        assert_eq!(
            outcome,
            TraceLoginOutcome::Status(format!(
                "Saved API key for Prime Agent Traces. Credentials saved to {}",
                agent.join("auth.json").display()
            ))
        );
        let (progress, _auth, prompts) = ui.logs();
        // The browser flow starts (its no-cli progress line lands) before
        // the pasted key overtakes it — both TS dialog progress lines.
        assert_eq!(
            progress,
            vec![
                "No Prime CLI API key found. Starting browser login...".to_string(),
                "Checking Prime Agent trace access...".to_string(),
            ]
        );
        // The prompt is the TS browser companion text.
        assert_eq!(prompts, vec![BROWSER_PROMPT.to_string()]);
        // The manual key was stored.
        let mut storage = AuthStorage::create(&agent);
        assert_eq!(
            storage
                .get_api_key_with_source_token("prime-agent-traces", false)
                .api_key,
            Some("manual-key".to_string())
        );
    }

    #[tokio::test]
    // The process env must stay stable across the flow's awaits:
    // the sync env lock is held for the whole test by design.
    #[allow(clippy::await_holding_lock)]
    async fn the_browser_login_completes_when_the_prompt_never_answers() {
        let _env = env_lock();
        std::env::remove_var("PRIME_AGENT_TRACES_BASE_URL");
        let (_dir, agent) = temp_agent();
        let http = ScriptedHttp::new(vec![whoami_ok()]);
        let ui = ScriptedUi::new(vec![Some("never".to_string())]);
        ui.wait_forever.store(true, Ordering::SeqCst);
        let ui = Arc::new(ui);
        let inputs = TracesLoginInputs {
            agent_dir: &agent,
            http: &http,
            prime_cli_config_path: None,
            poll_interval_ms: Some(10),
        };
        let outcome = run_traces_login_inner(&inputs, ui.as_ref()).await;
        assert!(matches!(outcome, TraceLoginOutcome::Status(_)));
        let (progress, auth, prompts) = ui.logs();
        assert_eq!(
            progress,
            vec![
                "No Prime CLI API key found. Starting browser login...".to_string(),
                "Checking Prime Agent trace access...".to_string(),
            ]
        );
        assert!(auth[0].contains("dashboard/tokens/challenge?code=ch-1&scope=agent_traces"));
        assert_eq!(prompts, vec![BROWSER_PROMPT.to_string()]);
        let mut storage = AuthStorage::create(&agent);
        assert_eq!(
            storage
                .get_api_key_with_source_token("prime-agent-traces", false)
                .api_key,
            Some("fixture-browser-key".to_string())
        );
    }

    #[tokio::test]
    // The process env must stay stable across the flow's awaits:
    // the sync env lock is held for the whole test by design.
    #[allow(clippy::await_holding_lock)]
    async fn a_denied_manual_key_reports_the_ts_error() {
        let _env = env_lock();
        std::env::remove_var("PRIME_AGENT_TRACES_BASE_URL");
        let (_dir, agent) = temp_agent();
        // The browser cannot start (the generate answer is down), the
        // fallback prompt arms, and the pasted key is denied.
        let http = ScriptedHttp::without_dynamic(vec![
            (
                "https://api.primeintellect.ai/api/v1/auth_challenge/generate",
                503,
                "",
            ),
            (
                "https://api.primeintellect.ai/api/v1/user/whoami",
                403,
                r#"{"error":{"message":"forbidden"}}"#,
            ),
        ]);
        let ui = Arc::new(ScriptedUi::new(vec![Some("bad-key".to_string())]));
        let inputs = TracesLoginInputs {
            agent_dir: &agent,
            http: &http,
            prime_cli_config_path: None,
            poll_interval_ms: None,
        };
        let outcome = run_traces_login_inner(&inputs, ui.as_ref()).await;
        assert_eq!(
            outcome,
            TraceLoginOutcome::Error(
                "Failed to login to Prime Agent Traces: Prime API key does not have Prime Agent trace access (HTTP 403: forbidden)"
                    .to_string()
            )
        );
    }

    #[tokio::test]
    // The process env must stay stable across the flow's awaits:
    // the sync env lock is held for the whole test by design.
    #[allow(clippy::await_holding_lock)]
    async fn a_cancelled_prompt_stays_silent() {
        let _env = env_lock();
        std::env::remove_var("PRIME_AGENT_TRACES_BASE_URL");
        let (_dir, agent) = temp_agent();
        // The browser flow arms the prompt; the closed input cancels the
        // login (the pending status poll yields first).
        let http = ScriptedHttp::new(vec![]);
        let ui = Arc::new(ScriptedUi::new(vec![None]));
        let inputs = TracesLoginInputs {
            agent_dir: &agent,
            http: &http,
            prime_cli_config_path: None,
            poll_interval_ms: None,
        };
        let outcome = run_traces_login_inner(&inputs, ui.as_ref()).await;
        assert_eq!(outcome, TraceLoginOutcome::Cancelled);
        // No credential landed.
        let storage = AuthStorage::create(&agent);
        assert!(storage.get_all().get("prime-agent-traces").is_none());
    }

    #[tokio::test]
    // The process env must stay stable across the flow's awaits:
    // the sync env lock is held for the whole test by design.
    #[allow(clippy::await_holding_lock)]
    async fn a_failed_browser_falls_back_to_the_paste_prompt() {
        let _env = env_lock();
        std::env::remove_var("PRIME_AGENT_TRACES_BASE_URL");
        let (_dir, agent) = temp_agent();
        // The challenge generate endpoint is down (the browser flow
        // fails before any URL shows).
        let http = ScriptedHttp::without_dynamic(vec![
            (
                "https://api.primeintellect.ai/api/v1/auth_challenge/generate",
                503,
                "",
            ),
            // The pasted fallback key's access check.
            whoami_ok(),
        ]);
        let ui = Arc::new(ScriptedUi::new(vec![Some("fallback-key".to_string())]));
        let inputs = TracesLoginInputs {
            agent_dir: &agent,
            http: &http,
            prime_cli_config_path: None,
            poll_interval_ms: None,
        };
        let outcome = run_traces_login_inner(&inputs, ui.as_ref()).await;
        assert!(matches!(outcome, TraceLoginOutcome::Status(_)));
        let (progress, _auth, prompts) = ui.logs();
        assert!(progress.contains(&"Browser sign-in unavailable (Failed to generate Prime login challenge: Service Unavailable).".to_string()));
        assert_eq!(prompts, vec![FALLBACK_PROMPT.to_string()]);
        // The pasted key was stored.
        let mut storage = AuthStorage::create(&agent);
        assert_eq!(
            storage
                .get_api_key_with_source_token("prime-agent-traces", false)
                .api_key,
            Some("fallback-key".to_string())
        );
    }
}
