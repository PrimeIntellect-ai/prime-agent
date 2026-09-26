//! The composition root's provider auth flows behind the TUI's `/login`
//! and `/logout` (TS `ProviderAuthFlows`): the provider catalog rows with
//! their auth status, the API-key store, the MCP device flow, the Prime
//! Inference terminal login (`prime_inference_login`), and the four
//! subscription logins — the Codex Subscription login
//! (`codex_subscription_login`) and the Anthropic, GitHub Copilot, and
//! xAI logins (`subscription_login`: the PKCE callback flow, the device
//! flows, the token exchanges, and the credential writes). The Prime
//! browser logins (the RSA `auth_challenge` flow) are not ported yet.

use std::path::PathBuf;

use pa_core::auth::{AuthCredential, AuthSource, AuthStatus};
use pa_core::models::ModelRegistry;
use pa_tui::provider_auth::{
    AuthFlow, AuthStatusIndicator, AuthStatusStyle, AuthType, ProviderAuthCommands,
    ProviderAuthFuture, ProviderAuthOutcome, ProviderRow, ProviderRowsFuture,
};

/// The TS OAuth provider rows (`the TS AI library/oauth` registry): the
/// subscription logins, every flow ported.
const SUBSCRIPTION_PROVIDERS: [(&str, &str); 4] = [
    ("anthropic", "Anthropic (Claude Pro/Max)"),
    ("github-copilot", "GitHub Copilot"),
    ("openai-codex", "ChatGPT Plus/Pro (Codex Subscription)"),
    ("xai", "xAI (Grok)"),
];

/// TS `BUILT_IN_PROVIDER_DISPLAY_NAMES` (provider id -> display name):
/// a known display name marks an API-key login provider.
const BUILT_IN_PROVIDER_DISPLAY_NAMES: &[(&str, &str)] = &[
    ("anthropic", "Anthropic"),
    ("amazon-bedrock", "Amazon Bedrock"),
    ("azure-openai-responses", "Azure OpenAI Responses"),
    ("cerebras", "Cerebras"),
    ("cloudflare-ai-gateway", "Cloudflare AI Gateway"),
    ("cloudflare-workers-ai", "Cloudflare Workers AI"),
    ("deepseek", "DeepSeek"),
    ("fireworks", "Fireworks"),
    ("google", "Google Gemini"),
    ("google-vertex", "Google Vertex AI"),
    ("groq", "Groq"),
    ("huggingface", "Hugging Face"),
    ("kimi-coding", "Kimi For Coding"),
    ("mistral", "Mistral"),
    ("minimax", "MiniMax"),
    ("minimax-cn", "MiniMax (China)"),
    ("moonshotai", "Moonshot AI"),
    ("moonshotai-cn", "Moonshot AI (China)"),
    ("opencode", "OpenCode Zen"),
    ("opencode-go", "OpenCode Go"),
    ("openai", "OpenAI"),
    ("openrouter", "OpenRouter"),
    ("prime-agent-traces", "Prime Agent Traces"),
    ("prime-inference", "Prime Inference"),
    ("vercel-ai-gateway", "Vercel AI Gateway"),
    ("xai", "xAI (Grok)"),
    ("zai", "ZAI"),
    ("xiaomi", "Xiaomi MiMo"),
    ("xiaomi-token-plan-cn", "Xiaomi MiMo Token Plan (China)"),
    (
        "xiaomi-token-plan-ams",
        "Xiaomi MiMo Token Plan (Amsterdam)",
    ),
    (
        "xiaomi-token-plan-sgp",
        "Xiaomi MiMo Token Plan (Singapore)",
    ),
];

const PRIME_INFERENCE_PROVIDER_ID: &str = "prime-inference";
const SERPER_CREDENTIAL_ID: &str = "serper";
const SERPER_CREDENTIAL_NAME: &str = "Serper (web search)";

/// The display name of a provider id (the TS map, else the id itself).
fn display_name(provider_id: &str) -> String {
    BUILT_IN_PROVIDER_DISPLAY_NAMES
        .iter()
        .find(|(id, _)| *id == provider_id)
        .map_or_else(|| provider_id.to_string(), |(_, name)| name.to_string())
}

/// TS `isApiKeyLoginProvider`: the display-name map, or a provider the
/// built-in model provider set does not know (custom models.json entries).
fn is_api_key_login_provider(
    provider_id: &str,
    built_in_provider_ids: &std::collections::HashSet<String>,
) -> bool {
    if BUILT_IN_PROVIDER_DISPLAY_NAMES
        .iter()
        .any(|(id, _)| *id == provider_id)
    {
        return true;
    }
    !built_in_provider_ids.contains(provider_id)
}

/// The provider's status indicator (TS `formatStatusIndicator` +
/// `formatApiKeyStatusIndicator`): the stored credential's match, the env
/// key, or the unconfigured hidden meta.
fn status_indicator(
    credential: Option<&AuthCredential>,
    status: &AuthStatus,
    auth_type: AuthType,
) -> Option<AuthStatusIndicator> {
    // A stale credential shows its warning label.
    if status.source == Some(AuthSource::Stale) {
        return Some(AuthStatusIndicator {
            style: AuthStatusStyle::Warning,
            label: status
                .label
                .clone()
                .unwrap_or_else(|| "expired".to_string()),
        });
    }
    // A non-stored source: env keys and config mark api-key providers
    // configured; subscription rows stay "unconfigured".
    if let Some(source) = status.source {
        if source != AuthSource::Stored {
            return match auth_type {
                AuthType::ApiKey => Some(AuthStatusIndicator {
                    style: AuthStatusStyle::Success,
                    label: api_key_source_label(source, status.label.as_deref()),
                }),
                AuthType::Oauth => Some(AuthStatusIndicator {
                    style: AuthStatusStyle::Muted,
                    label: "unconfigured".to_string(),
                }),
            };
        }
    }
    if let Some(credential) = credential {
        let credential_type = match credential {
            AuthCredential::ApiKey { .. } | AuthCredential::McpStaticToken { .. } => {
                AuthType::ApiKey
            }
            AuthCredential::Oauth { .. } => AuthType::Oauth,
        };
        return Some(if credential_type == auth_type {
            AuthStatusIndicator {
                style: AuthStatusStyle::Success,
                label: "configured".to_string(),
            }
        } else {
            AuthStatusIndicator {
                style: AuthStatusStyle::Warning,
                label: match credential_type {
                    AuthType::Oauth => "subscription configured".to_string(),
                    AuthType::ApiKey => "API key configured".to_string(),
                },
            }
        });
    }
    if auth_type != AuthType::ApiKey {
        return Some(AuthStatusIndicator {
            style: AuthStatusStyle::Muted,
            label: "unconfigured".to_string(),
        });
    }
    // An unconfigured api-key row hides its meta (TS inline rule).
    None
}

/// TS `formatApiKeyStatusIndicator`.
fn api_key_source_label(source: AuthSource, label: Option<&str>) -> String {
    match source {
        AuthSource::Environment => {
            format!("env: {}", label.unwrap_or("API key"))
        }
        AuthSource::PrimeCli => label.unwrap_or("Prime CLI").to_string(),
        AuthSource::Runtime => "runtime API key".to_string(),
        AuthSource::Fallback => "custom API key".to_string(),
        AuthSource::ModelsJsonKey => "key in models.json".to_string(),
        AuthSource::ModelsJsonCommand => "command in models.json".to_string(),
        AuthSource::Stored | AuthSource::Stale => "unconfigured".to_string(),
    }
}

/// TS `compareAuthSelectorProviders`: oauth before api key, then by name.
fn ts_row_order(a: &ProviderRow, b: &ProviderRow) -> std::cmp::Ordering {
    if a.auth_type != b.auth_type {
        return if a.auth_type == AuthType::Oauth {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        };
    }
    a.name.cmp(&b.name)
}

/// The provider auth surface against one daemon's shared directories.
#[derive(Clone)]
pub struct ProviderAuth {
    cwd: PathBuf,
    agent_dir: PathBuf,
}

impl ProviderAuth {
    pub fn new(cwd: impl Into<PathBuf>, agent_dir: impl Into<PathBuf>) -> Self {
        ProviderAuth {
            cwd: cwd.into(),
            agent_dir: agent_dir.into(),
        }
    }

    fn auth_storage(&self) -> pa_core::auth::AuthStorage {
        pa_core::auth::AuthStorage::create(&self.agent_dir)
    }

    /// The stored credential + auth status of one provider id.
    fn credential_status(&self, provider_id: &str) -> (Option<AuthCredential>, AuthStatus) {
        let auth = self.auth_storage();
        let credential = auth.get_all().credential(provider_id);
        let status = auth.get_auth_status(provider_id);
        (credential, status)
    }
}

impl ProviderAuthCommands for ProviderAuth {
    /// TS `getLoginProviderOptions`: the subscription rows, the MCP
    /// OAuth integrations, the API-key model providers, and the web
    /// search credential, sorted TS-style with prime-inference first.
    fn login_options(&self) -> ProviderRowsFuture {
        let provider = self.clone();
        Box::pin(async move {
            // The row build locks the auth store and the MCP manager
            // (blocking mutexes); keep them off the async workers.
            tokio::task::spawn_blocking(move || provider.login_rows_blocking())
                .await
                .expect("the row build task ran")
        })
    }

    /// TS `getLogoutProviderOptions`: one row per stored credential,
    /// sorted by name.
    fn logout_options(&self) -> ProviderRowsFuture {
        let provider = self.clone();
        Box::pin(async move {
            // The stored-credential list locks the auth store; keep it
            // off the async workers.
            tokio::task::spawn_blocking(move || provider.logout_rows_blocking())
                .await
                .expect("the row build task ran")
        })
    }

    /// TS `loginProvider`: the API-key store for prompted keys, the MCP
    /// device flow for integrations; the panel-driven subscription and
    /// Prime flows route through [`ProviderAuth::login_on_panel`].
    fn login(&self, provider: &ProviderRow, api_key: Option<&str>) -> ProviderAuthFuture {
        let provider_row = provider.clone();
        let agent_dir = self.agent_dir.clone();
        let api_key = api_key.map(str::to_string);
        Box::pin(async move {
            // The auth-store writes and the MCP manager locks stay off
            // the async workers.
            tokio::task::spawn_blocking(move || login_blocking(provider_row, agent_dir, api_key))
                .await
                .expect("the login task ran")
        })
    }

    /// TS `loginProvider` for the panel-driven flows (the MCP OAuth
    /// login, the Prime Inference login): the flow drives the inline
    /// auth panel (progress lines, prompts, the team picker render in
    /// the TUI; the oneshot replies answer the flow) and never touches
    /// the terminal.
    fn login_on_panel(
        &self,
        provider: &ProviderRow,
        panel: pa_tui::auth_panel::AuthPanelHandle,
    ) -> ProviderAuthFuture {
        let provider_row = provider.clone();
        let cwd = self.cwd.clone();
        let agent_dir = self.agent_dir.clone();
        Box::pin(async move {
            // The auth-store writes, the MCP manager locks, and the
            // panel round-trips stay off the async workers (a prompt's
            // answer arrives from the TUI loop's thread).
            tokio::task::spawn_blocking(move || {
                login_blocking_on_panel(provider_row, cwd, agent_dir, panel)
            })
            .await
            .expect("the login task ran")
        })
    }

    /// TS `runLogout`'s removal: the message matches the credential's
    /// type; a missing credential is a no-op notice.
    fn logout(&self, provider: &ProviderRow) -> ProviderAuthFuture {
        let provider_row = provider.clone();
        let agent_dir = self.agent_dir.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || logout_blocking(provider_row, agent_dir))
                .await
                .expect("the logout task ran")
        })
    }
}

impl ProviderAuth {
    /// The login row build (blocking: the auth store and MCP manager
    /// locks must stay off the async workers).
    fn login_rows_blocking(self) -> Vec<ProviderRow> {
        let provider = self;
        {
            let mut rows: Vec<ProviderRow> = Vec::new();

            // The subscription OAuth rows (TS `getOAuthProviders`).
            // Every flow is ported: the rows select and their logins
            // run through the panel (the menu rule's unavailable
            // marking stays for the surfaces a future row may lack).
            for (id, name) in SUBSCRIPTION_PROVIDERS {
                let (credential, status) = provider.credential_status(id);
                rows.push(ProviderRow {
                    id: id.to_string(),
                    name: name.to_string(),
                    auth_type: AuthType::Oauth,
                    status: status_indicator(credential.as_ref(), &status, AuthType::Oauth),
                    flow: AuthFlow::TerminalFlow,
                    configured: status.configured,
                    available: true,
                });
            }

            // The API-key model providers (TS `isApiKeyLoginProvider` over
            // the registry's provider set).
            let registry = ModelRegistry::create(
                provider.auth_storage(),
                provider.agent_dir.join("models.json"),
            );
            let built_in_provider_ids: std::collections::HashSet<String> =
                pa_ai::models_generated::get_providers()
                    .into_iter()
                    .map(str::to_string)
                    .collect();
            let mut providers: Vec<String> = registry
                .get_all()
                .iter()
                .map(|model| model.provider.clone())
                .collect();
            providers.sort();
            providers.dedup();
            for provider_id in providers {
                if !is_api_key_login_provider(&provider_id, &built_in_provider_ids) {
                    continue;
                }
                let (credential, status) = provider.credential_status(&provider_id);
                // Prime Inference logs in through the Prime flow, not a
                // pasted key (TS `loginProvider`'s special case).
                let flow = if provider_id == PRIME_INFERENCE_PROVIDER_ID {
                    AuthFlow::TerminalFlow
                } else {
                    AuthFlow::ApiKeyPrompt
                };
                rows.push(ProviderRow {
                    status: status_indicator(credential.as_ref(), &status, AuthType::ApiKey),
                    id: provider_id.clone(),
                    name: display_name(&provider_id),
                    auth_type: AuthType::ApiKey,
                    flow,
                    configured: status.configured,
                    available: true,
                });
            }

            // TS sort: configured first, prime-inference first among them,
            // then oauth before api key by name.
            rows.sort_by(|a, b| {
                let configured = |row: &ProviderRow| {
                    matches!(
                        row.status.as_ref().map(|status| status.style),
                        Some(AuthStatusStyle::Success)
                    )
                };
                configured(b).cmp(&configured(a)).then(ts_row_order(a, b))
            });
            let mut sorted: Vec<ProviderRow> = Vec::with_capacity(rows.len());
            let mut rest = rows;
            if let Some(index) = rest
                .iter()
                .position(|row| row.id == PRIME_INFERENCE_PROVIDER_ID)
            {
                sorted.push(rest.remove(index));
            }
            sorted.append(&mut rest);
            sorted
        }
    }

    /// The logout row build (blocking: the auth store lock stays off the
    /// async workers).
    fn logout_rows_blocking(self) -> Vec<ProviderRow> {
        let auth = self.auth_storage();
        let mut rows: Vec<ProviderRow> = Vec::new();
        for provider_id in auth.list() {
            let Some(credential) = auth.get_all().credential(&provider_id) else {
                continue;
            };
            let auth_type = match credential {
                AuthCredential::ApiKey { .. } | AuthCredential::McpStaticToken { .. } => {
                    AuthType::ApiKey
                }
                AuthCredential::Oauth { .. } => AuthType::Oauth,
            };
            let (is_serper, is_mcp) = (
                provider_id == SERPER_CREDENTIAL_ID,
                provider_id.starts_with("mcp:"),
            );
            let name = if is_serper {
                SERPER_CREDENTIAL_NAME.to_string()
            } else if is_mcp {
                provider_id
                    .strip_prefix("mcp:")
                    .unwrap_or(&provider_id)
                    .to_string()
            } else {
                display_name(&provider_id)
            };
            rows.push(ProviderRow {
                id: provider_id,
                name,
                auth_type,
                status: Some(AuthStatusIndicator {
                    style: AuthStatusStyle::Success,
                    label: "configured".to_string(),
                }),
                flow: AuthFlow::TerminalFlow,
                // The stored-credential rows exist because the credential
                // is there (TS `getProviderAuthStatus(id).configured`);
                // credential removal always runs (an unavailable row's
                // login never existed; its logout still removes the
                // stored credential).
                configured: true,
                available: true,
            });
        }
        rows.sort_by(|a, b| a.name.cmp(&b.name));
        rows
    }
}

/// The login flow body (blocking: the auth store and the MCP manager stay
/// off the async workers). The panel-driven rows (the MCP OAuth logins,
/// the Prime Inference login, the subscription logins) route to
/// [`login_blocking_on_panel`]; this body serves the panel-prompted key
/// store, and an OAuth row reaching it answers the silent cancel (the
/// session routes the panel rows to the panel body).
fn login_blocking(
    provider_row: ProviderRow,
    agent_dir: PathBuf,
    api_key: Option<String>,
) -> ProviderAuthOutcome {
    if provider_row.auth_type == AuthType::Oauth {
        // The panel-driven flows (the MCP logins, the Prime Inference
        // login) run on the panel. An OAuth row reaching this
        // non-panel body answers the silent cancel — the session
        // routes the panel rows to the panel body, and no row dead-ends
        // in an after-selection error wall.
        return ProviderAuthOutcome::Cancelled;
    }
    let Some(api_key) = api_key.filter(|key| !key.is_empty()) else {
        return ProviderAuthOutcome::Error(format!(
            "Failed to save API key for {}: API key cannot be empty.",
            provider_row.name
        ));
    };
    let mut auth = pa_core::auth::AuthStorage::create(&agent_dir);
    auth.set(
        &provider_row.id,
        AuthCredential::ApiKey {
            key: api_key,
            prime_team: None,
        },
    );
    if let Some(error) = auth.drain_errors().pop() {
        return ProviderAuthOutcome::Error(format!("could not save the API key: {error}"));
    }
    ProviderAuthOutcome::Status(format!(
        "Saved API key for {}. Credentials saved to {}",
        provider_row.name,
        agent_dir.join("auth.json").display()
    ))
}

/// The login flow body for the panel-driven rows (the MCP OAuth logins,
/// the Prime Inference login, the four subscription logins): blocking on
/// the dedicated thread — the
/// flow awaits its transport AND the panel's prompt/picker replies (the
/// answers arrive from the TUI loop's thread), and the inline auth panel
/// carries every surface the plain terminal used to.
fn login_blocking_on_panel(
    provider_row: ProviderRow,
    cwd: PathBuf,
    agent_dir: PathBuf,
    panel: pa_tui::auth_panel::AuthPanelHandle,
) -> ProviderAuthOutcome {
    if let Some(server) = provider_row.id.strip_prefix("mcp:") {
        let auth = crate::mcp_login::TerminalMcpAuth::new(cwd, agent_dir);
        let outcome = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_or_else(
                |error: std::io::Error| format!("login failed: {error}"),
                |runtime| {
                    runtime.block_on(pa_tui::client_auth::run_mcp_auth_command(
                        &auth,
                        &format!("login {server}"),
                        panel,
                    ))
                },
            );
        return if outcome.starts_with("Usage:") {
            ProviderAuthOutcome::Error(outcome)
        } else {
            ProviderAuthOutcome::Status(outcome)
        };
    }
    // TS `loginProvider`'s prime-inference dispatch: the API-key flow
    // (the browser challenge raced against the paste prompt, the whoami
    // check, the team selection) rendered through the panel.
    if provider_row.id == PRIME_INFERENCE_PROVIDER_ID {
        return tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_or_else(
                |error| {
                    ProviderAuthOutcome::Error(format!(
                        "Failed to login to {}: {error}",
                        provider_row.name
                    ))
                },
                |runtime| {
                    runtime.block_on(crate::prime_inference_login::run_prime_inference_login(
                        crate::prime_inference_login::PrimeLoginInputs {
                            agent_dir: &agent_dir,
                            provider_name: &provider_row.name,
                            config: &pa_core::auth::resolve_prime_inference_auth_config(),
                            http: &pa_core::auth::ReqwestPrimeHttp,
                            prime_cli_config_path:
                                crate::prime_inference_login::prime_cli_config_path(&agent_dir)
                                    .as_deref(),
                            prime_team_id: std::env::var("PRIME_TEAM_ID").ok().as_deref(),
                            poll_interval_ms: None,
                        },
                        &crate::prime_inference_login::PanelPrimeLoginUi::new(panel),
                    ))
                },
            );
    }
    // The Codex Subscription login (TS `loginProvider`'s dispatch to
    // the AI library's `openaiCodexOAuthProvider.login`): the browser
    // authorization URL block, the manual paste racing the localhost
    // callback, the token exchange, and the credential write, all
    // through the inline auth panel (TS the login dialog).
    if provider_row.id == pa_core::auth::OPENAI_CODEX_PROVIDER_ID {
        return tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_or_else(
                |error: std::io::Error| {
                    ProviderAuthOutcome::Error(format!(
                        "Failed to login to {}: {error}",
                        provider_row.name
                    ))
                },
                |runtime| {
                    runtime.block_on(
                        crate::codex_subscription_login::run_codex_subscription_login(
                            &agent_dir,
                            &provider_row.name,
                            &pa_ai::oauth::ReqwestCodexHttp::new(),
                            &crate::codex_subscription_login::PanelCodexLoginUi::new(panel),
                        ),
                    )
                },
            );
    }
    // The Anthropic (Claude Pro/Max) login (TS `loginProvider`'s
    // dispatch to the AI library's `anthropicOAuthProvider.login`):
    // the PKCE authorization URL, the manual paste racing the localhost
    // callback, the JSON token exchange, and the credential write, all
    // through the inline auth panel.
    if provider_row.id == pa_core::auth::ANTHROPIC_PROVIDER_ID {
        return tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_or_else(
                |error: std::io::Error| {
                    ProviderAuthOutcome::Error(format!(
                        "Failed to login to {}: {error}",
                        provider_row.name
                    ))
                },
                |runtime| {
                    runtime.block_on(crate::subscription_login::run_anthropic_login(
                        &agent_dir,
                        &provider_row.name,
                        &pa_ai::oauth::ReqwestProviderHttp::new(),
                        &crate::subscription_login::PanelSubscriptionLoginUi::new(
                            panel,
                            &provider_row.id,
                        ),
                    ))
                },
            );
    }
    // The GitHub Copilot login (TS `loginProvider`'s dispatch to the AI
    // library's `githubCopilotOAuthProvider.login`): the enterprise
    // domain prompt, the device flow, the Copilot token exchange, the
    // model-policy enabling, and the credential write, all through the
    // inline auth panel.
    if provider_row.id == pa_core::auth::GITHUB_COPILOT_PROVIDER_ID {
        return tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_or_else(
                |error: std::io::Error| {
                    ProviderAuthOutcome::Error(format!(
                        "Failed to login to {}: {error}",
                        provider_row.name
                    ))
                },
                |runtime| {
                    runtime.block_on(crate::subscription_login::run_github_copilot_login(
                        &agent_dir,
                        &provider_row.name,
                        &pa_ai::oauth::ReqwestProviderHttp::new(),
                        &crate::subscription_login::PanelSubscriptionLoginUi::new(
                            panel,
                            &provider_row.id,
                        ),
                    ))
                },
            );
    }
    // The xAI (Grok) login (TS `loginProvider`'s dispatch to the AI
    // library's `xaiOAuthProvider.login`): the device flow, the token
    // poll, and the credential write, all through the inline auth
    // panel.
    if provider_row.id == pa_core::auth::XAI_PROVIDER_ID {
        return tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_or_else(
                |error: std::io::Error| {
                    ProviderAuthOutcome::Error(format!(
                        "Failed to login to {}: {error}",
                        provider_row.name
                    ))
                },
                |runtime| {
                    runtime.block_on(crate::subscription_login::run_xai_login(
                        &agent_dir,
                        &provider_row.name,
                        &pa_ai::oauth::ReqwestProviderHttp::new(),
                        &crate::subscription_login::PanelSubscriptionLoginUi::new(
                            panel,
                            &provider_row.id,
                        ),
                    ))
                },
            );
    }
    // Any other row that reaches the panel body answers the silent
    // cancel (the session routes only the ported rows here — never an
    // error wall).
    ProviderAuthOutcome::Cancelled
}

/// The logout body (blocking: the auth store lock stays off the async
/// workers).
fn logout_blocking(provider_row: ProviderRow, agent_dir: PathBuf) -> ProviderAuthOutcome {
    let mut auth = pa_core::auth::AuthStorage::create(&agent_dir);
    if auth.get_all().get(&provider_row.id).is_none() {
        return ProviderAuthOutcome::Status(format!("{} is not configured.", provider_row.name));
    }
    auth.logout(&provider_row.id);
    if let Some(error) = auth.drain_errors().pop() {
        return ProviderAuthOutcome::Error(format!("Logout failed: {error}"));
    }
    match provider_row.auth_type {
        AuthType::Oauth => ProviderAuthOutcome::Status(format!(
            "Logged out of {}",
            provider_row.name
        )),
        AuthType::ApiKey => ProviderAuthOutcome::Status(format!(
            "Removed stored API key for {}. Environment variables and models.json config are unchanged.",
            provider_row.name
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_status_indicator_maps_the_ts_labels() {
        let stored_api_key = AuthCredential::ApiKey {
            key: "k".to_string(),
            prime_team: None,
        };
        // A matching stored credential is configured.
        assert_eq!(
            status_indicator(
                Some(&stored_api_key),
                &AuthStatus {
                    source: Some(AuthSource::Stored),
                    ..Default::default()
                },
                AuthType::ApiKey
            ),
            Some(AuthStatusIndicator {
                style: AuthStatusStyle::Success,
                label: "configured".to_string()
            })
        );
        // A subscription credential on an api-key row warns.
        assert_eq!(
            status_indicator(
                Some(&AuthCredential::Oauth {
                    access: "a".to_string(),
                    refresh: None,
                    expires: 1,
                    account_id: None,
                    endpoint: None,
                    token_endpoint: None,
                    client_id: None,
                    resource: None,
                    issuer: None,
                    enterprise_url: None,
                }),
                &AuthStatus::default(),
                AuthType::ApiKey
            ),
            Some(AuthStatusIndicator {
                style: AuthStatusStyle::Warning,
                label: "subscription configured".to_string()
            })
        );
        // An env key marks the api-key row configured.
        assert_eq!(
            status_indicator(
                None,
                &AuthStatus {
                    source: Some(AuthSource::Environment),
                    label: Some("OPENAI_API_KEY".to_string()),
                    ..Default::default()
                },
                AuthType::ApiKey
            ),
            Some(AuthStatusIndicator {
                style: AuthStatusStyle::Success,
                label: "env: OPENAI_API_KEY".to_string()
            })
        );
        // An unconfigured subscription row stays muted.
        assert_eq!(
            status_indicator(None, &AuthStatus::default(), AuthType::Oauth),
            Some(AuthStatusIndicator {
                style: AuthStatusStyle::Muted,
                label: "unconfigured".to_string()
            })
        );
        // An unconfigured api-key row hides its meta (TS inline rule).
        assert_eq!(
            status_indicator(None, &AuthStatus::default(), AuthType::ApiKey),
            None
        );
        // A stale credential warns.
        assert_eq!(
            status_indicator(
                None,
                &AuthStatus {
                    source: Some(AuthSource::Stale),
                    label: Some("expired".to_string()),
                    ..Default::default()
                },
                AuthType::Oauth
            ),
            Some(AuthStatusIndicator {
                style: AuthStatusStyle::Warning,
                label: "expired".to_string()
            })
        );
    }

    #[test]
    fn the_display_names_match_the_ts_map() {
        assert_eq!(display_name("openai"), "OpenAI");
        assert_eq!(display_name("google"), "Google Gemini");
        assert_eq!(display_name("prime-inference"), "Prime Inference");
        assert_eq!(display_name("a-custom-provider"), "a-custom-provider");
    }

    #[test]
    fn the_api_key_login_rule_matches_ts() {
        let mut built_in = std::collections::HashSet::new();
        built_in.insert("anthropic".to_string());
        // The display-name map marks api-key logins.
        assert!(is_api_key_login_provider("openai", &built_in));
        // A provider the built-in set does not know is a custom api-key
        // provider.
        assert!(is_api_key_login_provider("my-endpoint", &built_in));
        // A built-in provider without a display name is not an api-key
        // login (its subscription flows apply).
        assert!(!is_api_key_login_provider("faux", &{
            let mut set = std::collections::HashSet::new();
            set.insert("faux".to_string());
            set
        }));
    }

    #[tokio::test]
    async fn login_options_list_providers_only() {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent = dir.path().join("agent");
        std::fs::create_dir_all(&agent).expect("agent dir");
        std::env::remove_var("PRIME_AGENT_TRACES_API_KEY");
        std::env::remove_var("PRIME_API_KEY");
        let auth = ProviderAuth::new(dir.path(), agent.clone());
        let rows = auth.login_options().await;
        // The TS OAuth registry rows render; every subscription flow is
        // ported, so every row selects (the flows answer through the
        // panel — never an after-selection error wall).
        for (id, name) in SUBSCRIPTION_PROVIDERS {
            let row = rows
                .iter()
                .find(|row| row.id == id && row.name == name)
                .unwrap_or_else(|| panic!("the {id} subscription row renders"));
            assert!(
                row.available,
                "the {id} row's flow is ported and selectable"
            );
        }
        // The operator's 2026-09-24 directive: /login is providers only —
        // the service rows (MCP OAuth integrations, the web search
        // credential) never appear; the /mcp view owns MCP logins.
        assert!(!rows.iter().any(|row| row.id == "serper"));
        assert!(!rows.iter().any(|row| row.id.starts_with("mcp:")));
        // Prime Inference sorts first among the api-key rows (TS rule).
        assert!(
            rows.iter()
                .position(|row| row.id == PRIME_INFERENCE_PROVIDER_ID)
                < rows.iter().position(|row| row.id == "anthropic"),
            "prime-inference sorts before the other api-key rows"
        );
    }

    #[tokio::test]
    async fn login_stores_an_api_key_and_logout_removes_it() {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent = dir.path().join("agent");
        std::fs::create_dir_all(&agent).expect("agent dir");
        let auth = ProviderAuth::new(dir.path(), agent);
        let row = ProviderRow {
            id: "openai".to_string(),
            name: "OpenAI".to_string(),
            auth_type: AuthType::ApiKey,
            status: None,
            flow: AuthFlow::ApiKeyPrompt,
            configured: false,
            available: true,
        };
        match auth.login(&row, Some("sk-test")).await {
            ProviderAuthOutcome::Status(message) => {
                assert!(
                    message.starts_with("Saved API key for OpenAI. Credentials saved to "),
                    "the store status names the credential path: {message}"
                );
            }
            other => panic!("expected the store status, got {other:?}"),
        }
        // An empty key answers the TS error.
        assert_eq!(
            auth.login(&row, Some("")).await,
            ProviderAuthOutcome::Error(
                "Failed to save API key for OpenAI: API key cannot be empty.".to_string()
            )
        );
        // The logout lists the stored credential and removes it.
        let stored = auth.logout_options().await;
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].id, "openai");
        assert_eq!(
            auth.logout(&stored[0]).await,
            ProviderAuthOutcome::Status(
                "Removed stored API key for OpenAI. Environment variables and models.json config are unchanged."
                    .to_string()
            )
        );
        assert!(auth.logout_options().await.is_empty());
    }
}
