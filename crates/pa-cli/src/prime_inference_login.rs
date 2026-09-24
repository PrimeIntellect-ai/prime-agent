//! The composition root's terminal Prime Inference login (TS
//! `runPrimeInferenceLogin`'s API-key surface): the prime-cli credential
//! reuse, the pasted-key prompt with the whoami access check, the team
//! selection, and the credential write. The TS flow races its browser
//! challenge against the paste field; that challenge is not ported, so
//! the paste prompt is the only entry and no line claims a browser step.

use std::path::{Path, PathBuf};
use std::pin::Pin;

use pa_core::auth::{
    check_prime_inference_access, fetch_prime_teams, read_prime_cli_config, AuthStorage,
    PrimeAccessError, PrimeHttp, PrimeInferenceAuthConfig, PrimeTeamAssignment,
    PrimeTeamCredential, StoredPrimeTeam, DEFAULT_REQUEST_TIMEOUT_MS,
};
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

/// The login's terminal surface (the TS login dialog's surface): progress
/// lines, the paste prompt, and the team selection. The seam keeps the
/// flow scriptable in tests.
pub(crate) trait PrimeLoginUi {
    /// TS `onProgress` / `dialog.showProgress`.
    fn progress(&self, message: &str);
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
}

/// TS `runPrimeInferenceLogin`: the whole flow on the plain terminal (the
/// TUI is suspended around the call).
pub(crate) async fn run_prime_inference_login(
    inputs: PrimeLoginInputs<'_>,
    ui: &dyn PrimeLoginUi,
) -> ProviderAuthOutcome {
    // TS `loginPrimeInference`'s candidate path: the prime CLI's
    // production credential logs in without a prompt when it carries
    // inference access.
    let candidate = if inputs.config.is_production() {
        inputs.prime_cli_config_path.and_then(read_prime_cli_config)
    } else {
        None
    };
    let mut checked_cli_key = false;
    if let Some(candidate) = candidate {
        if let Some(api_key) = candidate.api_key {
            checked_cli_key = true;
            ui.progress("Checking existing Prime CLI credentials...");
            match check_prime_inference_access(
                inputs.http,
                &inputs.config.base_url,
                &api_key,
                DEFAULT_REQUEST_TIMEOUT_MS,
            )
            .await
            {
                Ok(()) => {
                    let team = match candidate.team {
                        Some(team) => PrimeTeamAssignment::Team(team),
                        None => PrimeTeamAssignment::PersonalAccount,
                    };
                    return complete_login(&inputs, &api_key, team, ui).await;
                }
                // TS continues to the browser login here; the paste
                // prompt is this build's entry, so the line stops before
                // the browser claim.
                Err(PrimeAccessError::Denied(failure)) => ui.progress(&format!(
                    "Existing Prime CLI key cannot access Prime Inference ({}).",
                    failure.format()
                )),
                Err(PrimeAccessError::Failed(message)) => {
                    return ProviderAuthOutcome::Error(format!(
                        "Failed to login to {}: {message}",
                        inputs.provider_name
                    ));
                }
            }
        }
    }
    if !checked_cli_key {
        // TS's line minus the browser step this build does not run.
        ui.progress("No eligible production Prime CLI API key found.");
    }

    // The pasted key (TS `armManualInput`'s fallback surface).
    let Some(api_key) = prompt_non_empty(ui, "Paste a Prime API key below:").await else {
        return ProviderAuthOutcome::Cancelled;
    };
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
    complete_login(
        &inputs,
        &api_key,
        // TS: a manual entry carries no team — the stored selection of the
        // same key survives.
        PrimeTeamAssignment::PreserveWhenKeyMatches,
        ui,
    )
    .await
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
    let chosen = match ui.select_team(&teams, current.as_deref()).await {
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

/// The terminal login surface while the TUI is suspended: progress
/// lines, the paste prompt, and the numbered team list (the TS login
/// dialog's and team selector's surface).
pub(crate) struct TerminalPrimeLoginUi;

impl PrimeLoginUi for TerminalPrimeLoginUi {
    fn progress(&self, message: &str) {
        println!("{message}");
    }

    fn prompt_line(
        &self,
        prompt: &str,
    ) -> Pin<Box<dyn std::future::Future<Output = Option<String>> + Send + '_>> {
        let prompt = prompt.to_string();
        Box::pin(async move {
            println!("{prompt}");
            crate::mcp_login::read_terminal_line().await
        })
    }

    fn select_team(
        &self,
        teams: &[PrimeTeamCredential],
        current: Option<&str>,
    ) -> Pin<Box<dyn std::future::Future<Output = TeamChoice> + Send + '_>> {
        let lines = team_list_lines(teams, current);
        let teams = teams.to_vec();
        Box::pin(async move {
            for line in &lines {
                println!("{line}");
            }
            loop {
                let Some(line) = crate::mcp_login::read_terminal_line().await else {
                    return TeamChoice::Cancelled;
                };
                let line = line.trim();
                if line.is_empty() {
                    return TeamChoice::Cancelled;
                }
                match line.parse::<usize>() {
                    Ok(1) => return TeamChoice::PersonalAccount,
                    Ok(number) if (2..=teams.len() + 1).contains(&number) => {
                        return TeamChoice::Team(teams[number - 2].clone());
                    }
                    // The TS selector ignores keys that select nothing.
                    _ => {}
                }
            }
        })
    }
}

/// The team selector's rendered lines (the TS `PrimeTeamSelector`'s
/// rows): the panel title and subtitle, Personal first, the slug/role
/// meta, the current marker, and the numbered-selection hint.
fn team_list_lines(teams: &[PrimeTeamCredential], current: Option<&str>) -> Vec<String> {
    let marker = |team_id: Option<&str>| {
        if current == team_id {
            " (current)"
        } else {
            ""
        }
    };
    let mut lines = vec![
        "Select a Prime Team:".to_string(),
        "Choose which account pays for Prime Inference usage.".to_string(),
        format!("  1. Personal — personal account{}", marker(None)),
    ];
    for (index, team) in teams.iter().enumerate() {
        let role = team
            .role
            .as_deref()
            .map_or_else(|| "member".to_string(), str::to_lowercase);
        let secondary = match &team.slug {
            Some(slug) => format!("slug: {slug}, role: {role}"),
            None => format!("role: {role}"),
        };
        lines.push(format!(
            "  {}. {} — {secondary}{}",
            index + 2,
            team.name,
            marker(Some(&team.team_id))
        ));
    }
    lines.push("Enter a team number, or press Enter to keep the current selection:".to_string());
    lines
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
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    /// A scripted transport: exact URL -> response, in call order; the
    /// served requests land in the log.
    struct ScriptedHttp {
        queue: Mutex<VecDeque<(String, pa_core::auth::PrimeHttpResponse)>>,
        served: Mutex<Vec<String>>,
    }

    impl ScriptedHttp {
        fn new(responses: Vec<(&str, u16, &str)>) -> Self {
            ScriptedHttp {
                queue: Mutex::new(
                    responses
                        .into_iter()
                        .map(|(url, status, body)| {
                            (
                                url.to_string(),
                                pa_core::auth::PrimeHttpResponse {
                                    status,
                                    body: body.to_string(),
                                },
                            )
                        })
                        .collect(),
                ),
                served: Mutex::new(Vec::new()),
            }
        }

        fn requests(&self) -> Vec<String> {
            self.served.lock().unwrap().clone()
        }
    }

    impl PrimeHttp for ScriptedHttp {
        fn get(
            &self,
            url: &str,
            _api_key: &str,
            _timeout_ms: u64,
        ) -> Pin<
            Box<
                dyn std::future::Future<Output = Result<pa_core::auth::PrimeHttpResponse, String>>
                    + Send,
            >,
        > {
            let url = url.to_string();
            let entry = self.queue.lock().unwrap().pop_front();
            self.served.lock().unwrap().push(url.clone());
            Box::pin(async move {
                match entry {
                    Some((expected_url, response)) if expected_url == url => Ok(response),
                    Some((expected_url, _)) => {
                        panic!("unexpected request {url}, scripted {expected_url}")
                    }
                    None => panic!("no scripted response for {url}"),
                }
            })
        }

        fn post_json<'a>(
            &'a self,
            url: &'a str,
            _body: &'a str,
            _bearer: Option<&'a str>,
            _timeout_ms: u64,
        ) -> Pin<
            Box<
                dyn std::future::Future<Output = Result<pa_core::auth::PrimeHttpResponse, String>>
                    + Send
                    + 'a,
            >,
        > {
            let url = url.to_string();
            let entry = self.queue.lock().unwrap().pop_front();
            self.served.lock().unwrap().push(url.clone());
            Box::pin(async move {
                match entry {
                    Some((expected_url, response)) if expected_url == url => Ok(response),
                    Some((expected_url, _)) => {
                        panic!("unexpected request {url}, scripted {expected_url}")
                    }
                    None => panic!("no scripted response for {url}"),
                }
            })
        }
    }

    /// A scripted UI: the queued paste lines and team choices answer in
    /// order; progress lines land in the log.
    struct ScriptedUi {
        progress: Arc<Mutex<Vec<String>>>,
        pastes: Mutex<VecDeque<Option<String>>>,
        choices: Mutex<VecDeque<TeamChoice>>,
    }

    impl ScriptedUi {
        fn new(pastes: Vec<Option<String>>, choices: Vec<TeamChoice>) -> Self {
            ScriptedUi {
                progress: Arc::new(Mutex::new(Vec::new())),
                pastes: Mutex::new(pastes.into_iter().collect()),
                choices: Mutex::new(choices.into_iter().collect()),
            }
        }

        fn progress_log(&self) -> Vec<String> {
            self.progress.lock().unwrap().clone()
        }
    }

    impl PrimeLoginUi for ScriptedUi {
        fn progress(&self, message: &str) {
            self.progress.lock().unwrap().push(message.to_string());
        }

        fn prompt_line(
            &self,
            _prompt: &str,
        ) -> Pin<Box<dyn std::future::Future<Output = Option<String>> + Send + '_>> {
            let next = self
                .pastes
                .lock()
                .unwrap()
                .pop_front()
                .expect("the test queued a paste entry");
            Box::pin(async move { next })
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
                "No eligible production Prime CLI API key found.".to_string(),
                "Checking Prime Inference access...".to_string(),
                "Loading Prime teams...".to_string(),
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
                "Existing Prime CLI key cannot access Prime Inference (HTTP 403: denied)."
                    .to_string(),
                "Checking Prime Inference access...".to_string(),
                "Loading Prime teams...".to_string(),
            ]
        );
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
        // No team list request went out.
        assert_eq!(http.requests().len(), 1);
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

    #[test]
    fn the_terminal_team_list_renders_the_ts_rows() {
        // The terminal list is the TS selector's surface: the panel title
        // and subtitle, Personal first, the slug/role meta, and the
        // current marker.
        let teams = vec![
            PrimeTeamCredential {
                slug: Some("one".to_string()),
                role: Some("Member".to_string()),
                ..team("t-1", "Team One")
            },
            team("t-2", "Team Two"),
        ];
        assert_eq!(
            team_list_lines(&teams, Some("t-2")),
            vec![
                "Select a Prime Team:".to_string(),
                "Choose which account pays for Prime Inference usage.".to_string(),
                "  1. Personal — personal account".to_string(),
                "  2. Team One — slug: one, role: member".to_string(),
                "  3. Team Two — role: member (current)".to_string(),
                "Enter a team number, or press Enter to keep the current selection:".to_string(),
            ]
        );
    }
}
