//! The composition root's Prime Inference login (TS
//! `runPrimeInferenceLogin`): the core login's prime-cli credential
//! reuse, the browser challenge raced against the pasted-key prompt,
//! the whoami access check, the team selection, and the credential
//! write. The race and its cooperative cancellation follow the traces
//! login's proven shape (TS `Promise.race([browserLoginOrFallback,
//! manualKeyEntry, dialogCancelled])`; a manual key drops the browser
//! poll mid-flight and a failed browser keeps the prompt under the
//! fallback text). The flow renders through the inline auth panel (TS
//! the login dialog and the `PrimeTeamSelectorComponent` mount in the
//! TUI): every progress line, the auth URL, the paste prompt, and the
//! team picker ride the panel channel, and no surface touches the
//! terminal.

use std::path::{Path, PathBuf};
use std::pin::{pin, Pin};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use pa_core::auth::{
    check_prime_inference_access, fetch_prime_teams, login_prime_inference, AuthStorage,
    PrimeAccessError, PrimeAuthInfo, PrimeHttp, PrimeInferenceAuthConfig,
    PrimeInferenceLoginCallbacks, PrimeInferenceLoginOptions, PrimeInferenceLoginResult,
    PrimeTeamAssignment, PrimeTeamCredential, StoredPrimeTeam, DEFAULT_REQUEST_TIMEOUT_MS,
};
use pa_tui::auth_panel::{PasteStyle, PrimeTeamOption, PrimeTeamPick};
use pa_tui::provider_auth::ProviderAuthOutcome;

/// The result of the team selection (TS `PrimeTeamSelectorComponent`'s
/// `onSelect`/`onCancel`).
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum TeamChoice {
    Team(PrimeTeamCredential),
    /// TS `onSelect(null)`: the personal account.
    PersonalAccount,
    /// TS `onCancel`: the stored selection stays untouched.
    Cancelled,
}

/// TS `armManualInput`'s armed prompt after the browser URL shows.
const BROWSER_PROMPT: &str = "Complete the sign-in in your browser, or paste an API key below:";
/// TS the browser-unavailable fallback's prompt.
const FALLBACK_PROMPT: &str = "Paste a Prime API key below:";

/// The login's terminal surface (the TS login dialog's surface): progress
/// lines, the auth URL, the paste prompt, and the team selection. The seam
/// keeps the flow scriptable in tests; `Send + Sync` because the race's
/// boxed arms are `Send`.
pub(crate) trait PrimeLoginUi: Send + Sync {
    /// TS `onProgress` / `dialog.showProgress`.
    fn progress(&self, message: &str);
    /// The driving surface's cooperative cancel state: `true` once the
    /// pane that mounted the login exited. The flow checks it before
    /// its auth-store writes — a `JoinHandle::abort` cannot reach a
    /// started `spawn_blocking` body, so the pane marks this instead.
    /// The default (`false`) serves the surfaces that never cancel
    /// mid-flow (the scripted tests, the plain terminal).
    fn is_cancelled(&self) -> bool {
        false
    }
    /// TS `dialog.showAuth` (the URL + the code line) and the terminal
    /// port's browser open.
    fn on_auth(&self, url: &str, instructions: &str);
    /// One paste prompt (TS `armManualInput`): an empty line re-prompts,
    /// `None` (the input surface went away) cancels the login.
    fn prompt_line(
        &self,
        prompt: &str,
    ) -> Pin<Box<dyn std::future::Future<Output = Option<String>> + Send + '_>>;
    /// The team selection over the fetched teams; `current` is the stored
    /// team id when one applies (TS preselects it).
    fn select_team(
        &self,
        teams: &[PrimeTeamCredential],
        current: Option<&str>,
    ) -> Pin<Box<dyn std::future::Future<Output = TeamChoice> + Send + '_>>;
}

/// The login's resolved inputs: the store's agent dir, the provider's
/// display name, the challenge config and transport, the prime-cli reuse
/// candidate (TS `getPrimeCliConfigPath()`: enabled only when the agent
/// dir is the resolved default), and the raw `PRIME_TEAM_ID` pin.
pub(crate) struct PrimeLoginInputs<'a> {
    pub agent_dir: &'a Path,
    pub provider_name: &'a str,
    pub config: &'a PrimeInferenceAuthConfig,
    pub http: &'a dyn PrimeHttp,
    pub prime_cli_config_path: Option<&'a Path>,
    pub prime_team_id: Option<&'a str>,
    /// The challenge poll interval (the product's 5s default; tests use
    /// milliseconds so the race's arms resolve deterministically).
    pub poll_interval_ms: Option<u64>,
}

/// TS `runPrimeInferenceLogin`: the whole flow against the login UI seam
/// (the inline auth panel in the TUI, a scripted UI in tests).
pub(crate) async fn run_prime_inference_login(
    inputs: PrimeLoginInputs<'_>,
    ui: &dyn PrimeLoginUi,
) -> ProviderAuthOutcome {
    // TS `loginPrimeInference`'s options: the prime-cli reuse rides the
    // core's own candidate pass, so the flow's prelude is the challenge
    // race alone.
    let mut options = PrimeInferenceLoginOptions::new(inputs.prime_cli_config_path);
    options.poll_interval_ms = inputs.poll_interval_ms;
    // TS `armManualInput`: the paste prompt arms when the browser URL
    // shows, and again (under the fallback text) when the browser flow
    // fails before it does.
    let (arm_tx, mut arm_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let armed = Arc::new(AtomicBool::new(false));
    let on_auth = {
        let armed = armed.clone();
        let arm_tx = arm_tx.clone();
        move |info: &PrimeAuthInfo| {
            ui.on_auth(&info.url, &info.instructions);
            if !armed.swap(true, Ordering::SeqCst) {
                let _ = arm_tx.send(BROWSER_PROMPT.to_string());
            }
        }
    };
    let on_progress = |message: &str| ui.progress(message);
    let callbacks = PrimeInferenceLoginCallbacks {
        on_auth: &on_auth,
        on_progress: Some(&on_progress),
    };
    let mut login = pin!(login_prime_inference(
        inputs.http,
        inputs.config,
        &options,
        &callbacks
    ));
    // The local sender keeps the arm channel open for the fallback arm
    // (the login future's own sender dies with it).
    let _keep_arm_open = arm_tx;

    let mut manual: Option<Pin<Box<dyn std::future::Future<Output = Option<String>> + Send + '_>>> =
        None;
    // Whether the arm signal has been consumed (the armed flag inside
    // the closure guards the double-send; this one gates the select arm).
    let mut arm_seen = false;
    let mut login_dead = false;
    loop {
        // TS `Promise.race([browserLoginOrFallback, manualKeyEntry,
        // dialogCancelled])`: whichever settles first wins; the loser is
        // dropped (the browser poll on a manual key, the paste read on a
        // browser key — the pane exit tears the whole flow down).
        enum Step {
            Login(Result<PrimeInferenceLoginResult, String>),
            Armed,
            Manual(Option<String>),
        }
        let step = tokio::select! {
            result = &mut login, if !login_dead => Step::Login(result),
            _ = arm_rx.recv(), if !arm_seen => Step::Armed,
            line = async { manual.as_mut().expect("the manual read is armed").as_mut().await }, if manual.is_some() => Step::Manual(line),
        };
        match step {
            Step::Login(Ok(result)) => {
                // The result carries the team the credential write binds:
                // the cli candidate's team, or the browser arm's
                // preserve-when-key-matches (the core's TS parity).
                return complete_login(&inputs, &result.api_key, result.prime_team, ui).await;
            }
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
                    return ProviderAuthOutcome::Cancelled;
                };
                // The race's loser is dropped above (TS the manual path's
                // `browserAbort.abort()`); the pane exit ends the flow.
                if ui.is_cancelled() {
                    return ProviderAuthOutcome::Cancelled;
                }
                ui.progress("Checking Prime Inference access...");
                match check_prime_inference_access(
                    inputs.http,
                    &inputs.config.base_url,
                    &api_key,
                    DEFAULT_REQUEST_TIMEOUT_MS,
                )
                .await
                {
                    Ok(()) => {}
                    Err(PrimeAccessError::Denied(failure)) => {
                        return ProviderAuthOutcome::Error(format!(
                            "Failed to login to {}: Prime API key does not have Prime Inference access ({})",
                            inputs.provider_name,
                            failure.format()
                        ));
                    }
                    Err(PrimeAccessError::Failed(message)) => {
                        return ProviderAuthOutcome::Error(format!(
                            "Failed to login to {}: {message}",
                            inputs.provider_name
                        ));
                    }
                }
                return complete_login(
                    &inputs,
                    &api_key,
                    // TS: a manual entry carries no team — the stored
                    // selection of the same key survives.
                    PrimeTeamAssignment::PreserveWhenKeyMatches,
                    ui,
                )
                .await;
            }
        }
    }
}

/// TS `armManualInput`'s loop: the prompt repeats until a non-empty line
/// arrives; a closed input cancels.
async fn prompt_non_empty(ui: &dyn PrimeLoginUi, prompt: &str) -> Option<String> {
    loop {
        let line = ui.prompt_line(prompt).await?;
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
}

/// TS `completePrimeInferenceLogin` + `completeProviderAuthentication`:
/// store the key, select the team, and report the TS status.
async fn complete_login(
    inputs: &PrimeLoginInputs<'_>,
    api_key: &str,
    team: PrimeTeamAssignment,
    ui: &dyn PrimeLoginUi,
) -> ProviderAuthOutcome {
    // The pane exited while the login ran: no credential write lands —
    // the exit ends the flow (TS the dialog's abort signal).
    if ui.is_cancelled() {
        return ProviderAuthOutcome::Cancelled;
    }
    let mut auth = AuthStorage::create(inputs.agent_dir);
    auth.set_prime_inference_api_key(api_key, team);
    if let Some(error) = auth.drain_errors().pop() {
        return ProviderAuthOutcome::Error(format!(
            "Failed to login to {}: {error}",
            inputs.provider_name
        ));
    }
    let team_status = select_team(&mut auth, inputs, api_key, ui).await;
    ProviderAuthOutcome::Status(format!(
        "Saved API key for {}. Credentials saved to {}. {team_status}",
        inputs.provider_name,
        inputs.agent_dir.join("auth.json").display()
    ))
}

/// TS `selectPrimeInferenceTeam`: bind the stored key's team and report
/// its status line. A failed fetch or write leaves the stored selection
/// (TS's catch reloads and reports the default status).
async fn select_team(
    auth: &mut AuthStorage,
    inputs: &PrimeLoginInputs<'_>,
    api_key: &str,
    ui: &dyn PrimeLoginUi,
) -> String {
    // A pinned PRIME_TEAM_ID wins: nothing is stored (TS reloads and
    // reports the env status).
    if inputs
        .prime_team_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
    {
        auth.reload();
        return "Using team from PRIME_TEAM_ID.".to_string();
    }
    // The pane exited: the stored key keeps its standing selection (the
    // same state as a failed fetch below).
    if ui.is_cancelled() {
        return default_team_status(auth, inputs.prime_team_id);
    }
    ui.progress("Loading Prime teams...");
    let teams = match fetch_prime_teams(
        inputs.http,
        &inputs.config.base_url,
        api_key,
        DEFAULT_REQUEST_TIMEOUT_MS,
    )
    .await
    {
        Ok(teams) => teams,
        Err(_) => return default_team_status(auth, inputs.prime_team_id),
    };
    // The pane exited while the fetch ran: the stored key keeps its
    // standing selection — the write below never lands.
    if ui.is_cancelled() {
        return default_team_status(auth, inputs.prime_team_id);
    }
    if teams.is_empty() {
        auth.set_prime_inference_team_selection(None, Some(api_key));
        return match auth.drain_errors().pop() {
            Some(_) => default_team_status(auth, inputs.prime_team_id),
            None => "Using personal account.".to_string(),
        };
    }
    let current = match auth.get_prime_inference_team_selection() {
        StoredPrimeTeam::Team(team) => Some(team.team_id),
        _ => None,
    };
    let picked = ui.select_team(&teams, current.as_deref()).await;
    // The pane exited while the picker waited: the stored key keeps its
    // standing selection — the binding writes below never land.
    if ui.is_cancelled() {
        return default_team_status(auth, inputs.prime_team_id);
    }
    let chosen = match picked {
        TeamChoice::Team(team) => {
            auth.set_prime_inference_team_selection(Some(team.clone()), Some(api_key));
            Some(format!("Using team \"{}\".", team.name))
        }
        TeamChoice::PersonalAccount => {
            auth.set_prime_inference_team_selection(None, Some(api_key));
            Some("Using personal account.".to_string())
        }
        TeamChoice::Cancelled => None,
    };
    match auth.drain_errors().pop() {
        Some(_) => default_team_status(auth, inputs.prime_team_id),
        None => chosen.unwrap_or_else(|| default_team_status(auth, inputs.prime_team_id)),
    }
}

/// TS `getPrimeInferenceDefaultTeamStatus`: the env pin, the stored
/// selection, else the personal account.
fn default_team_status(auth: &AuthStorage, prime_team_id: Option<&str>) -> String {
    if prime_team_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
    {
        return "Using team from PRIME_TEAM_ID.".to_string();
    }
    match auth.get_prime_inference_team_selection() {
        StoredPrimeTeam::Team(team) => format!("Using team \"{}\".", team.name),
        StoredPrimeTeam::PersonalAccount | StoredPrimeTeam::NotSelected => {
            "Using personal account.".to_string()
        }
    }
}

/// The login's inline-panel surface (TS the login dialog renders in the
/// TUI): progress lines, the paste prompt, and the team selection drive
/// the auth panel through the request channel (the TUI loop answers the
/// prompts and the picker); the flow never touches the terminal.
pub(crate) struct PanelPrimeLoginUi {
    panel: pa_tui::auth_panel::AuthPanelHandle,
}

impl PanelPrimeLoginUi {
    pub(crate) fn new(panel: pa_tui::auth_panel::AuthPanelHandle) -> Self {
        PanelPrimeLoginUi { panel }
    }
}

impl PrimeLoginUi for PanelPrimeLoginUi {
    fn progress(&self, message: &str) {
        self.panel.progress(message);
    }

    fn on_auth(&self, url: &str, instructions: &str) {
        self.panel.auth_url(url, Some(instructions));
        pa_core::platform::browser::open_in_browser(url);
    }

    fn is_cancelled(&self) -> bool {
        self.panel.cancelled()
    }

    fn prompt_line(
        &self,
        prompt: &str,
    ) -> Pin<Box<dyn std::future::Future<Output = Option<String>> + Send + '_>> {
        let panel = self.panel.clone();
        let prompt = prompt.to_string();
        Box::pin(async move { panel.paste_prompt(&prompt, PasteStyle::Visible).await })
    }

    fn select_team(
        &self,
        teams: &[PrimeTeamCredential],
        current: Option<&str>,
    ) -> Pin<Box<dyn std::future::Future<Output = TeamChoice> + Send + '_>> {
        let options = teams
            .iter()
            .map(|team| PrimeTeamOption {
                team_id: team.team_id.clone(),
                name: team.name.clone(),
                slug: team.slug.clone(),
                role: team.role.clone(),
                created_at: team.created_at.clone(),
            })
            .collect::<Vec<_>>();
        let panel = self.panel.clone();
        let current = current.map(str::to_string);
        Box::pin(async move {
            match panel.select_team(options, current.as_deref()).await {
                PrimeTeamPick::Team(team) => TeamChoice::Team(PrimeTeamCredential {
                    team_id: team.team_id,
                    name: team.name,
                    slug: team.slug,
                    role: team.role,
                    created_at: team.created_at,
                }),
                PrimeTeamPick::PersonalAccount => TeamChoice::PersonalAccount,
                PrimeTeamPick::Cancelled => TeamChoice::Cancelled,
            }
        })
    }
}

/// TS `getPrimeCliConfigPath`'s enablement: the prime CLI config is
/// consulted only when the agent dir is the resolved default (TS
/// `usePrimeCliConfig: effectiveAgentDir === options.agentDir`).
pub(crate) fn prime_cli_config_path(agent_dir: &Path) -> Option<PathBuf> {
    (agent_dir == crate::config::get_agent_dir()).then(pa_core::auth::default_prime_cli_config_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use rsa::pkcs8::DecodePublicKey;
    use std::collections::VecDeque;
    use std::sync::atomic::AtomicBool;
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
        ) -> Pin<Box<dyn std::future::Future<Output = Result<PrimeHttpResponse, String>> + Send>>
        {
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
        ) -> Pin<Box<dyn std::future::Future<Output = Result<PrimeHttpResponse, String>> + Send + 'a>>
        {
            let url = url.to_string();
            let body = body.to_string();
            self.served.lock().unwrap().push(url.clone());
            Box::pin(async move {
                if self.dynamic_generate && url.ends_with("/api/v1/auth_challenge/generate") {
                    // Capture the flow's public key so the status poll can
                    // encrypt the fixture key with it.
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

    /// The scripted login surface: progress lines, the auth URL, the
    /// prompts, the pastes, and the team choice land in their logs; the
    /// `wait_forever` flag holds the paste unanswered (the browser login
    /// resolves while the armed prompt never answers).
    struct ScriptedUi {
        progress: Arc<Mutex<Vec<String>>>,
        auth: Mutex<Vec<String>>,
        prompt_seen: Mutex<Vec<String>>,
        pastes: Mutex<VecDeque<Option<String>>>,
        choices: Mutex<VecDeque<TeamChoice>>,
        wait_forever: AtomicBool,
    }

    impl ScriptedUi {
        fn new(pastes: Vec<Option<String>>, choices: Vec<TeamChoice>) -> Self {
            ScriptedUi {
                progress: Arc::new(Mutex::new(Vec::new())),
                auth: Mutex::new(Vec::new()),
                prompt_seen: Mutex::new(Vec::new()),
                pastes: Mutex::new(pastes.into_iter().collect()),
                choices: Mutex::new(choices.into_iter().collect()),
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

        fn progress_log(&self) -> Vec<String> {
            self.progress.lock().unwrap().clone()
        }
    }

    impl PrimeLoginUi for ScriptedUi {
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
        ) -> Pin<Box<dyn std::future::Future<Output = Option<String>> + Send + '_>> {
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

        fn select_team(
            &self,
            _teams: &[PrimeTeamCredential],
            _current: Option<&str>,
        ) -> Pin<Box<dyn std::future::Future<Output = TeamChoice> + Send + '_>> {
            let next = self.choices.lock().unwrap().pop_front();
            Box::pin(async move { next.unwrap_or(TeamChoice::Cancelled) })
        }
    }

    /// The production challenge config (the scripted transport keeps the
    /// requests hermetic).
    fn production_config() -> PrimeInferenceAuthConfig {
        PrimeInferenceAuthConfig {
            base_url: pa_core::auth::DEFAULT_PRIME_API_BASE_URL.to_string(),
            frontend_url: pa_core::auth::DEFAULT_PRIME_FRONTEND_URL.to_string(),
        }
    }

    fn team(id: &str, name: &str) -> PrimeTeamCredential {
        PrimeTeamCredential {
            team_id: id.to_string(),
            name: name.to_string(),
            slug: None,
            role: None,
            created_at: None,
        }
    }

    fn whoami_ok() -> (&'static str, u16, &'static str) {
        (
            "https://api.primeintellect.ai/api/v1/user/whoami",
            200,
            r#"{"data":{"scope":{"inference":{"write":true}}}}"#,
        )
    }

    fn teams_request() -> &'static str {
        "https://api.primeintellect.ai/api/v1/user/teams?offset=0&limit=100"
    }

    /// One login run against scripted UI and transport; the agent dir,
    /// the prime-cli candidate, and the env pin come from the test.
    async fn login(
        agent_dir: &std::path::Path,
        ui: &ScriptedUi,
        http: &ScriptedHttp,
        prime_cli_config_path: Option<&std::path::Path>,
        prime_team_id: Option<&str>,
    ) -> ProviderAuthOutcome {
        run_prime_inference_login(
            PrimeLoginInputs {
                agent_dir,
                provider_name: "Prime Inference",
                config: &production_config(),
                http,
                prime_cli_config_path,
                prime_team_id,
                // A short poll keeps the browser arm's pending round
                // deterministically slower than the armed paste.
                poll_interval_ms: Some(10),
            },
            ui,
        )
        .await
    }

    #[tokio::test]
    async fn a_pasted_key_validates_persists_and_selects_the_team() {
        let http = ScriptedHttp::new(vec![
            whoami_ok(),
            (
                teams_request(),
                200,
                r#"{"total_count":1,"data":[{"teamId":"t-1","name":"Team One","slug":"one","role":"member"}]}"#,
            ),
        ]);
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let ui = ScriptedUi::new(
            vec![Some(" sk-new ".to_string())],
            vec![TeamChoice::Team(PrimeTeamCredential {
                slug: Some("one".to_string()),
                role: Some("member".to_string()),
                ..team("t-1", "Team One")
            })],
        );
        assert_eq!(
            login(&agent_dir, &ui, &http, None, None).await,
            ProviderAuthOutcome::Status(format!(
                "Saved API key for Prime Inference. Credentials saved to {}. Using team \"Team One\".",
                agent_dir.join("auth.json").display()
            ))
        );
        assert_eq!(
            ui.progress_log(),
            vec![
                "No eligible production Prime CLI API key found. Starting browser login..."
                    .to_string(),
                "Checking Prime Inference access...".to_string(),
                "Loading Prime teams...".to_string(),
            ]
        );
        // The browser URL armed the paste prompt; the manual key won the
        // race, so the challenge poll never resolved (no result read, no
        // browser whoami).
        let (progress, auth, prompts) = ui.logs();
        assert_eq!(progress, ui.progress_log());
        assert_eq!(
            auth,
            vec![
                "Code: ch-1\nhttps://app.primeintellect.ai/dashboard/tokens/challenge?code=ch-1"
                    .to_string(),
            ]
        );
        assert_eq!(prompts, vec![BROWSER_PROMPT.to_string()]);
        let requests = http.requests();
        assert_eq!(
            requests[..2],
            [
                "https://api.primeintellect.ai/api/v1/auth_challenge/generate".to_string(),
                "https://api.primeintellect.ai/api/v1/auth_challenge/status?challenge=ch-1"
                    .to_string(),
            ]
        );
        // The stored credential carries the key and the selected team.
        let auth = AuthStorage::create(&agent_dir);
        assert_eq!(
            auth.get_prime_inference_team_selection(),
            StoredPrimeTeam::Team(PrimeTeamCredential {
                slug: Some("one".to_string()),
                role: Some("member".to_string()),
                ..team("t-1", "Team One")
            })
        );
        assert_eq!(
            auth.get_all()
                .credential("prime-inference")
                .map(|credential| credential.credential_type()),
            Some("api_key")
        );
    }

    #[tokio::test]
    async fn the_prime_cli_candidate_short_circuits_when_it_has_access() {
        let http = ScriptedHttp::new(vec![
            whoami_ok(),
            (
                teams_request(),
                200,
                r#"{"total_count":1,"data":[{"teamId":"t-9","name":"Nine"}]}"#,
            ),
        ]);
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        // The production prime-cli config (no URL overrides) with a team.
        let cli_config = dir.path().join("config.json");
        std::fs::write(
            &cli_config,
            serde_json::json!({"api_key": "sk-cli", "team_id": "t-9", "team_name": "Nine"})
                .to_string(),
        )
        .expect("write config");
        let ui = ScriptedUi::new(vec![], vec![]);
        assert_eq!(
            login(&agent_dir, &ui, &http, Some(&cli_config), None).await,
            ProviderAuthOutcome::Status(format!(
                "Saved API key for Prime Inference. Credentials saved to {}. Using team \"Nine\".",
                agent_dir.join("auth.json").display()
            ))
        );
        // No paste prompt ran; the candidate's progress lines are TS's.
        assert_eq!(
            ui.progress_log(),
            vec![
                "Checking existing Prime CLI credentials...".to_string(),
                "Loading Prime teams...".to_string(),
            ]
        );
        let auth = AuthStorage::create(&agent_dir);
        assert_eq!(
            auth.get_prime_inference_team_selection(),
            StoredPrimeTeam::Team(team("t-9", "Nine"))
        );
    }

    #[tokio::test]
    async fn a_denied_cli_candidate_falls_through_to_the_paste_prompt() {
        let http = ScriptedHttp::new(vec![
            (
                "https://api.primeintellect.ai/api/v1/user/whoami",
                403,
                r#"{"error":{"message":"denied"}}"#,
            ),
            whoami_ok(),
            (
                teams_request(),
                200,
                r#"{"total_count":1,"data":[{"teamId":"t-1","name":"Team One"}]}"#,
            ),
        ]);
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let cli_config = dir.path().join("config.json");
        std::fs::write(
            &cli_config,
            serde_json::json!({"api_key": "sk-cli"}).to_string(),
        )
        .expect("write config");
        let ui = ScriptedUi::new(
            vec![Some("sk-new".to_string())],
            vec![TeamChoice::PersonalAccount],
        );
        assert_eq!(
            login(&agent_dir, &ui, &http, Some(&cli_config), None).await,
            ProviderAuthOutcome::Status(format!(
                "Saved API key for Prime Inference. Credentials saved to {}. Using personal account.",
                agent_dir.join("auth.json").display()
            ))
        );
        assert_eq!(
            ui.progress_log(),
            vec![
                "Checking existing Prime CLI credentials...".to_string(),
                "Existing Prime CLI key cannot access Prime Inference (HTTP 403: denied). Starting browser login..."
                    .to_string(),
                "Checking Prime Inference access...".to_string(),
                "Loading Prime teams...".to_string(),
            ]
        );
        // The denied candidate falls to the browser challenge, whose URL
        // arms the paste prompt; the pasted key wins the race.
        let (_, auth, prompts) = ui.logs();
        assert_eq!(
            auth,
            vec![
                "Code: ch-1\nhttps://app.primeintellect.ai/dashboard/tokens/challenge?code=ch-1"
                    .to_string(),
            ]
        );
        assert_eq!(prompts, vec![BROWSER_PROMPT.to_string()]);
    }

    #[tokio::test]
    async fn a_denied_key_reports_the_ts_error() {
        let http = ScriptedHttp::new(vec![(
            "https://api.primeintellect.ai/api/v1/user/whoami",
            403,
            r#"{"error":{"message":"denied"}}"#,
        )]);
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let ui = ScriptedUi::new(vec![Some("sk-bad".to_string())], vec![]);
        assert_eq!(
            login(&agent_dir, &ui, &http, None, None).await,
            ProviderAuthOutcome::Error(
                "Failed to login to Prime Inference: Prime API key does not have Prime Inference access (HTTP 403: denied)"
                    .to_string(),
            )
        );
        // Nothing was stored.
        assert!(AuthStorage::create(&agent_dir)
            .get_all()
            .get("prime-inference")
            .is_none());
        // The race's prelude and the manual check are the flow's own
        // lines; the core's browser check never ran (the paste won).
        assert_eq!(
            ui.progress_log(),
            vec![
                "No eligible production Prime CLI API key found. Starting browser login..."
                    .to_string(),
                "Checking Prime Inference access...".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn an_empty_paste_reprompts_and_eof_cancels() {
        let http = ScriptedHttp::new(vec![whoami_ok()]);
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        // An empty line re-prompts; EOF cancels silently.
        let ui = ScriptedUi::new(vec![Some("   ".to_string()), None], vec![]);
        assert_eq!(
            login(&agent_dir, &ui, &http, None, None).await,
            ProviderAuthOutcome::Cancelled
        );
        assert!(AuthStorage::create(&agent_dir)
            .get_all()
            .get("prime-inference")
            .is_none());
    }

    #[tokio::test]
    async fn a_failed_team_fetch_keeps_the_stored_selection() {
        let http = ScriptedHttp::new(vec![whoami_ok(), (teams_request(), 500, "boom")]);
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        // A stored credential on the same key keeps its team selection
        // when the team list cannot load.
        std::fs::write(
            agent_dir.join("auth.json"),
            serde_json::json!({
                "prime-inference": {
                    "type": "api_key",
                    "key": "sk-same",
                    "primeTeam": { "teamId": "t-1", "name": "Team One" }
                }
            })
            .to_string(),
        )
        .expect("write auth");
        let ui = ScriptedUi::new(vec![Some("sk-same".to_string())], vec![]);
        assert_eq!(
            login(&agent_dir, &ui, &http, None, None).await,
            ProviderAuthOutcome::Status(format!(
                "Saved API key for Prime Inference. Credentials saved to {}. Using team \"Team One\".",
                agent_dir.join("auth.json").display()
            ))
        );
        // The failed fetch wrote the key but left the stored team.
        let auth = AuthStorage::create(&agent_dir);
        assert_eq!(
            auth.get_prime_inference_team_selection(),
            StoredPrimeTeam::Team(team("t-1", "Team One"))
        );
    }

    #[tokio::test]
    async fn the_pinned_team_env_skips_the_team_list() {
        let http = ScriptedHttp::new(vec![whoami_ok()]);
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let ui = ScriptedUi::new(vec![Some("sk-new".to_string())], vec![]);
        assert_eq!(
            login(&agent_dir, &ui, &http, None, Some("env-team")).await,
            ProviderAuthOutcome::Status(format!(
                "Saved API key for Prime Inference. Credentials saved to {}. Using team from PRIME_TEAM_ID.",
                agent_dir.join("auth.json").display()
            ))
        );
        // No team list request went out (the browser challenge and the
        // manual key's check did).
        assert!(!http
            .requests()
            .iter()
            .any(|request| request.contains("/api/v1/user/teams")));
    }

    #[tokio::test]
    async fn selecting_personal_account_overrides_the_stored_team() {
        let http = ScriptedHttp::new(vec![
            whoami_ok(),
            (
                teams_request(),
                200,
                r#"{"total_count":1,"data":[{"teamId":"t-2","name":"Two"}]}"#,
            ),
        ]);
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        std::fs::write(
            agent_dir.join("auth.json"),
            serde_json::json!({
                "prime-inference": {
                    "type": "api_key",
                    "key": "sk-same",
                    "primeTeam": { "teamId": "t-1", "name": "Team One" }
                }
            })
            .to_string(),
        )
        .expect("write auth");
        let ui = ScriptedUi::new(
            vec![Some("sk-same".to_string())],
            vec![TeamChoice::PersonalAccount],
        );
        assert_eq!(
            login(&agent_dir, &ui, &http, None, None).await,
            ProviderAuthOutcome::Status(format!(
                "Saved API key for Prime Inference. Credentials saved to {}. Using personal account.",
                agent_dir.join("auth.json").display()
            ))
        );
        let auth = AuthStorage::create(&agent_dir);
        assert_eq!(
            auth.get_prime_inference_team_selection(),
            StoredPrimeTeam::PersonalAccount
        );
    }

    #[tokio::test]
    async fn cancelling_the_team_selection_keeps_the_stored_team() {
        let http = ScriptedHttp::new(vec![
            whoami_ok(),
            (
                teams_request(),
                200,
                r#"{"total_count":1,"data":[{"teamId":"t-2","name":"Two"}]}"#,
            ),
        ]);
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        std::fs::write(
            agent_dir.join("auth.json"),
            serde_json::json!({
                "prime-inference": {
                    "type": "api_key",
                    "key": "sk-same",
                    "primeTeam": { "teamId": "t-1", "name": "Team One" }
                }
            })
            .to_string(),
        )
        .expect("write auth");
        let ui = ScriptedUi::new(
            vec![Some("sk-same".to_string())],
            vec![TeamChoice::Cancelled],
        );
        assert_eq!(
            login(&agent_dir, &ui, &http, None, None).await,
            ProviderAuthOutcome::Status(format!(
                "Saved API key for Prime Inference. Credentials saved to {}. Using team \"Team One\".",
                agent_dir.join("auth.json").display()
            ))
        );
        let auth = AuthStorage::create(&agent_dir);
        assert_eq!(
            auth.get_prime_inference_team_selection(),
            StoredPrimeTeam::Team(team("t-1", "Team One"))
        );
    }

    #[tokio::test]
    async fn the_browser_login_completes_when_the_prompt_never_answers() {
        let http = ScriptedHttp::new(vec![
            whoami_ok(),
            (
                teams_request(),
                200,
                r#"{"total_count":1,"data":[{"teamId":"t-1","name":"Team One"}]}"#,
            ),
        ]);
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let ui = ScriptedUi::new(
            vec![Some("held".to_string())],
            vec![TeamChoice::Team(team("t-1", "Team One"))],
        );
        // The armed paste never answers: the browser challenge wins the
        // race.
        ui.wait_forever.store(true, Ordering::SeqCst);
        assert_eq!(
            login(&agent_dir, &ui, &http, None, None).await,
            ProviderAuthOutcome::Status(format!(
                "Saved API key for Prime Inference. Credentials saved to {}. Using team \"Team One\".",
                agent_dir.join("auth.json").display()
            ))
        );
        // The browser arm's own lines ride the core's progress; the flow
        // never prompts past the armed (unanswered) paste.
        assert_eq!(
            ui.progress_log(),
            vec![
                "No eligible production Prime CLI API key found. Starting browser login..."
                    .to_string(),
                "Checking Prime Inference access...".to_string(),
                "Loading Prime teams...".to_string(),
            ]
        );
        let (_, auth, prompts) = ui.logs();
        // TS sends no scope for the inference arm: the URL keeps only the
        // code, with the code line next to it.
        assert_eq!(
            auth,
            vec![
                "Code: ch-1\nhttps://app.primeintellect.ai/dashboard/tokens/challenge?code=ch-1"
                    .to_string(),
            ]
        );
        assert_eq!(prompts, vec![BROWSER_PROMPT.to_string()]);
        // The poll resolved (pending once, then the encrypted key) before
        // the whoami and the teams fetch.
        assert_eq!(
            http.requests()[..4],
            [
                "https://api.primeintellect.ai/api/v1/auth_challenge/generate".to_string(),
                "https://api.primeintellect.ai/api/v1/auth_challenge/status?challenge=ch-1"
                    .to_string(),
                "https://api.primeintellect.ai/api/v1/auth_challenge/status?challenge=ch-1"
                    .to_string(),
                "https://api.primeintellect.ai/api/v1/user/whoami".to_string(),
            ]
        );
        // The browser arm's key is the stored credential.
        let auth = AuthStorage::create(&agent_dir);
        assert!(matches!(
            auth.get_all().credential("prime-inference"),
            Some(pa_core::auth::AuthCredential::ApiKey { key, .. }) if key == "fixture-browser-key"
        ));
        assert_eq!(
            auth.get_prime_inference_team_selection(),
            StoredPrimeTeam::Team(team("t-1", "Team One"))
        );
    }

    #[tokio::test]
    async fn a_failed_browser_falls_back_to_the_paste_prompt() {
        // The challenge generate endpoint is down: the browser flow
        // fails before its URL shows, so the fallback prompt arms under
        // the unavailable line and the pasted key completes the login.
        let http = ScriptedHttp::without_dynamic(vec![
            (
                "https://api.primeintellect.ai/api/v1/auth_challenge/generate",
                500,
                "Service Unavailable",
            ),
            whoami_ok(),
            (
                teams_request(),
                200,
                r#"{"total_count":1,"data":[{"teamId":"t-1","name":"Team One"}]}"#,
            ),
        ]);
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let ui = ScriptedUi::new(
            vec![Some("sk-new".to_string())],
            vec![TeamChoice::PersonalAccount],
        );
        assert_eq!(
            login(&agent_dir, &ui, &http, None, None).await,
            ProviderAuthOutcome::Status(format!(
                "Saved API key for Prime Inference. Credentials saved to {}. Using personal account.",
                agent_dir.join("auth.json").display()
            ))
        );
        assert_eq!(
            ui.progress_log(),
            vec![
                "No eligible production Prime CLI API key found. Starting browser login..."
                    .to_string(),
                "Browser sign-in unavailable (Failed to generate Prime login challenge: Service Unavailable)."
                    .to_string(),
                "Checking Prime Inference access...".to_string(),
                "Loading Prime teams...".to_string(),
            ]
        );
        let (_, auth, prompts) = ui.logs();
        // No browser URL ever showed; the fallback prompt is the TS text.
        assert!(auth.is_empty(), "no browser URL on the failed browser");
        assert_eq!(prompts, vec![FALLBACK_PROMPT.to_string()]);
    }
}
