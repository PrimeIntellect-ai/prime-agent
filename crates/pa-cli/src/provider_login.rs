//! The composition root's provider auth flows behind the TUI's `/login`
//! and `/logout` (TS `ProviderAuthFlows`): the provider catalog rows with
//! their auth status, the API-key store, the MCP device flow, the Prime
//! Inference terminal login (`prime_inference_login`), and the credential
//! removal. The provider OAuth flows (TS `the TS AI library/oauth`:
//! Anthropic, GitHub Copilot, OpenAI Codex, xAI subscriptions) and the
//! Prime browser logins (the RSA `auth_challenge` flow) are not ported
//! yet; their rows render (TS shape) and their flows report the
//! unavailability.

use std::path::PathBuf;

use pa_core::auth::{AuthCredential, AuthSource, AuthStatus};
use pa_core::models::ModelRegistry;
use pa_tui::provider_auth::{
    AuthCategory, AuthFlow, AuthStatusIndicator, AuthStatusStyle, AuthType, ProviderAuthCommands,
    ProviderAuthFuture, ProviderAuthOutcome, ProviderRow, ProviderRowsFuture,
    ProviderWarningFuture,
};

/// The TS OAuth provider rows (`the TS AI library/oauth` registry): subscription
/// logins whose flows this build does not port yet.
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
        .map(|(_, name)| name.to_string())
        .unwrap_or_else(|| provider_id.to_string())
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

/// TS `ANTHROPIC_SUBSCRIPTION_AUTH_WARNING` (#2645): subscription
/// requests identify as Claude Code, which may violate Anthropic's
/// terms; an API key avoids the risk.
const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING: &str = "Anthropic subscription auth is active. Usage draws from your plan limits, but Prime Agent identifies as Claude Code and this may violate Anthropic's terms — your account can be restricted or banned. An Anthropic API key avoids the risk. Manage usage at https://claude.ai/settings/usage.";

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

    /// The MCP manager over the same settings + builtin catalog the
    /// `/mcp` flows use (`TerminalMcpAuth::manager`).
    fn mcp_manager(&self) -> pa_core::mcp::McpManager {
        let cwd = self.cwd.clone();
        let agent_dir = self.agent_dir.clone();
        let catalog_cwd = self.cwd.clone();
        let catalog_agent_dir = self.agent_dir.clone();
        pa_core::mcp::McpManager::new(pa_core::mcp::McpManagerOptions {
            auth_storage: self.auth_storage_with_oauth(),
            get_user_servers: Box::new(move || {
                let settings = pa_core::settings::SettingsManager::create(&cwd, &agent_dir);
                Some(
                    settings
                        .settings()
                        .mcp_servers
                        .clone()
                        .unwrap_or_default()
                        .into_iter()
                        .filter_map(|(server, config)| {
                            serde_json::from_value::<pa_core::mcp::McpServerConfig>(config)
                                .ok()
                                .map(|parsed| (server, parsed))
                        })
                        .collect(),
                )
            }),
            begin_login: None,
            agent_dir: Some(self.agent_dir.clone()),
            get_catalog_sources: Some(Box::new({
                let cwd = catalog_cwd;
                let agent_dir = catalog_agent_dir;
                move || {
                    let settings = pa_core::settings::SettingsManager::create(&cwd, &agent_dir);
                    settings
                        .settings()
                        .mcp_catalog_sources
                        .clone()
                        .unwrap_or_default()
                }
            })),
            remote_source: None,
            probe_override: None,
        })
    }

    fn auth_storage_with_oauth(&self) -> pa_core::auth::AuthStorage {
        pa_core::auth::AuthStorage::create_with_oauth(
            &self.agent_dir,
            std::sync::Arc::new(pa_core::mcp::McpOAuth::new()),
        )
    }

    /// The stored credential + auth status of one provider id.
    fn credential_status(&self, provider_id: &str) -> (Option<AuthCredential>, AuthStatus) {
        let auth = self.auth_storage();
        let credential = auth.get_all().credential(provider_id);
        let status = auth.get_auth_status(provider_id);
        (credential, status)
    }

    /// TS `getAnthropicSubscriptionAuthWarning` (#2645, blocking body):
    /// the ban-risk warning applies when the stored Anthropic credential
    /// is an OAuth login, or the resolved key is a subscription token
    /// (`sk-ant-oat...` — the same prefix the provider layer treats as
    /// OAuth). `None` = the auth is not a subscription.
    fn anthropic_subscription_warning_blocking(&self) -> Option<&'static str> {
        let mut auth = self.auth_storage();
        if let Some(credential) = auth.get_all().credential("anthropic") {
            if matches!(credential, AuthCredential::Oauth { .. }) {
                return Some(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
            }
        }
        auth.get_api_key("anthropic")
            .is_some_and(|key| key.starts_with("sk-ant-oat"))
            .then_some(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING)
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
    /// device flow for integrations; the subscription/Prime flows report
    /// their unported state.
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

    /// TS `getAnthropicSubscriptionAuthWarning` (#2645): the ban-risk
    /// warning for an active Anthropic subscription auth, for the session
    /// surface to show once per run. The store lock (and the key
    /// resolution, which may run a `!command` credential) stay off the
    /// async workers.
    fn anthropic_subscription_warning(&self) -> ProviderWarningFuture {
        let provider = self.clone();
        Box::pin(async move {
            // The lookup is warning-only (TS ignores auth lookup failures
            // the same way), so a hung `!command` credential must not pin
            // the session surface: the TS resolution caps command
            // execution at 10s (`execSyncHidden`/`spawnSyncHidden`
            // `timeout: 10000`), and the check resolves no-warning at the
            // same bound.
            let lookup = tokio::task::spawn_blocking(move || {
                provider.anthropic_subscription_warning_blocking()
            });
            match tokio::time::timeout(std::time::Duration::from_secs(10), lookup).await {
                Ok(joined) => joined.unwrap_or(None),
                Err(_) => None,
            }
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

            // The subscription OAuth rows (TS `getOAuthProviders`). Their
            // login flows are not ported; the rows keep the TS shape.
            for (id, name) in SUBSCRIPTION_PROVIDERS {
                let (credential, status) = provider.credential_status(id);
                rows.push(ProviderRow {
                    id: id.to_string(),
                    name: name.to_string(),
                    auth_type: AuthType::Oauth,
                    category: AuthCategory::Provider,
                    status: status_indicator(credential.as_ref(), &status, AuthType::Oauth),
                    flow: AuthFlow::TerminalFlow,
                });
            }

            // The MCP OAuth integrations (Service rows; the device flow
            // runs like `/mcp login`).
            for mcp in provider.mcp_manager().list_status() {
                if !mcp.uses_oauth {
                    continue;
                }
                let id = format!("mcp:{}", mcp.server);
                let (credential, status) = provider.credential_status(&id);
                rows.push(ProviderRow {
                    status: status_indicator(credential.as_ref(), &status, AuthType::Oauth),
                    id,
                    name: mcp.label,
                    auth_type: AuthType::Oauth,
                    category: AuthCategory::Service,
                    flow: AuthFlow::TerminalFlow,
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
                    category: AuthCategory::Provider,
                    flow,
                });
            }

            // The web search credential (a service, not a model provider).
            let (credential, status) = provider.credential_status(SERPER_CREDENTIAL_ID);
            rows.push(ProviderRow {
                status: status_indicator(credential.as_ref(), &status, AuthType::ApiKey),
                id: SERPER_CREDENTIAL_ID.to_string(),
                name: SERPER_CREDENTIAL_NAME.to_string(),
                auth_type: AuthType::ApiKey,
                category: AuthCategory::Service,
                flow: AuthFlow::ApiKeyPrompt,
            });

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
                category: if is_serper || is_mcp {
                    AuthCategory::Service
                } else {
                    AuthCategory::Provider
                },
                status: Some(AuthStatusIndicator {
                    style: AuthStatusStyle::Success,
                    label: "configured".to_string(),
                }),
                flow: AuthFlow::TerminalFlow,
            });
        }
        rows.sort_by(|a, b| a.name.cmp(&b.name));
        rows
    }
}

/// The login flow body (blocking: the auth store and the MCP manager stay
/// off the async workers). The panel-driven rows (the MCP OAuth logins,
/// the Prime Inference login) route to [`login_blocking_on_panel`]; this
/// body serves the panel-prompted key store and the unported OAuth
/// stubs.
fn login_blocking(
    provider_row: ProviderRow,
    agent_dir: PathBuf,
    api_key: Option<String>,
) -> ProviderAuthOutcome {
    if provider_row.auth_type == AuthType::Oauth {
        return ProviderAuthOutcome::Error(format!(
            "{} subscription login is not available in this build yet.",
            provider_row.name
        ));
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
/// the Prime Inference login): blocking on the dedicated thread — the
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
            .map(|runtime| {
                runtime.block_on(pa_tui::client_auth::run_mcp_auth_command(
                    &auth,
                    &format!("login {server}"),
                    panel,
                ))
            })
            .unwrap_or_else(|error: std::io::Error| format!("login failed: {error}"));
        return if outcome.starts_with("Usage:") {
            ProviderAuthOutcome::Error(outcome)
        } else {
            ProviderAuthOutcome::Status(outcome)
        };
    }
    // TS `loginProvider`'s prime-inference dispatch: the API-key flow
    // (the paste prompt, the whoami check, the team selection; the
    // browser challenge stays unported) rendered through the panel.
    if provider_row.id == PRIME_INFERENCE_PROVIDER_ID {
        return tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map(|runtime| {
                runtime.block_on(crate::prime_inference_login::run_prime_inference_login(
                    crate::prime_inference_login::PrimeLoginInputs {
                        agent_dir: &agent_dir,
                        provider_name: &provider_row.name,
                        config: &pa_core::auth::resolve_prime_inference_auth_config(),
                        http: &pa_core::auth::ReqwestPrimeHttp,
                        prime_cli_config_path: crate::prime_inference_login::prime_cli_config_path(
                            &agent_dir,
                        )
                        .as_deref(),
                        prime_team_id: std::env::var("PRIME_TEAM_ID").ok().as_deref(),
                    },
                    &crate::prime_inference_login::PanelPrimeLoginUi::new(panel),
                ))
            })
            .unwrap_or_else(|error| {
                ProviderAuthOutcome::Error(format!(
                    "Failed to login to {}: {error}",
                    provider_row.name
                ))
            });
    }
    // Any other row that reaches the panel body reports the stub (the
    // session routes only the panel rows here).
    ProviderAuthOutcome::Error(format!(
        "{} subscription login is not available in this build yet.",
        provider_row.name
    ))
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
                    endpoint: None,
                    token_endpoint: None,
                    client_id: None,
                    resource: None,
                    issuer: None,
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
    async fn login_options_lists_the_subscription_and_mcp_rows() {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent = dir.path().join("agent");
        std::fs::create_dir_all(&agent).expect("agent dir");
        std::env::remove_var("PRIME_AGENT_TRACES_API_KEY");
        std::env::remove_var("PRIME_API_KEY");
        let auth = ProviderAuth::new(dir.path(), agent.clone());
        let rows = auth.login_options().await;
        // The TS OAuth registry rows render (their flows stay unported).
        for (id, name) in SUBSCRIPTION_PROVIDERS {
            assert!(
                rows.iter().any(|row| row.id == id && row.name == name),
                "the {id} subscription row renders"
            );
        }
        // The web search credential is a service row.
        assert!(rows.iter().any(|row| row.id == "serper"));
        // Prime Inference sorts first among the api-key rows (TS rule).
        assert!(
            rows.iter()
                .position(|row| row.id == PRIME_INFERENCE_PROVIDER_ID)
                <= rows.iter().position(|row| row.id == "serper"),
            "prime-inference sorts before the service rows"
        );
    }

    /// Port of the TS #2645 warning detection: the ban-risk warning is
    /// reported exactly when the active Anthropic credential is the
    /// subscription (a stored OAuth login or an `sk-ant-oat` key), and
    /// its text names the risk.
    #[tokio::test]
    async fn the_anthropic_subscription_warning_matches_the_active_credential() {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent = dir.path().join("agent");
        std::fs::create_dir_all(&agent).expect("agent dir");
        std::env::remove_var("ANTHROPIC_API_KEY");
        let auth = ProviderAuth::new(dir.path(), agent.clone());

        // No credential: no warning.
        assert_eq!(auth.anthropic_subscription_warning().await, None);

        // A plain API key: no warning (an API key avoids the risk).
        let mut storage = pa_core::auth::AuthStorage::create(&agent);
        storage.set(
            "anthropic",
            AuthCredential::ApiKey {
                key: "sk-ant-api03-plain".to_string(),
                prime_team: None,
            },
        );
        assert_eq!(auth.anthropic_subscription_warning().await, None);

        // A subscription token key (TS `isAnthropicSubscriptionAuthKey`).
        storage.set(
            "anthropic",
            AuthCredential::ApiKey {
                key: "sk-ant-oat-subscription".to_string(),
                prime_team: None,
            },
        );
        let warning = auth
            .anthropic_subscription_warning()
            .await
            .expect("a sk-ant-oat key is the subscription");
        assert!(warning.contains("identifies as Claude Code"));
        assert!(warning.contains("restricted or banned"));
        assert!(warning.contains("An Anthropic API key avoids the risk"));

        // A stored OAuth login is the subscription too.
        storage.set(
            "anthropic",
            AuthCredential::Oauth {
                access: "a".to_string(),
                refresh: None,
                expires: i64::MAX,
                endpoint: None,
                token_endpoint: None,
                client_id: None,
                resource: None,
                issuer: None,
            },
        );
        assert!(auth.anthropic_subscription_warning().await.is_some());

        // An env subscription key resolves active with no stored credential.
        storage.remove("anthropic");
        std::env::set_var("ANTHROPIC_API_KEY", "sk-ant-oat-env");
        assert!(auth.anthropic_subscription_warning().await.is_some());
        std::env::remove_var("ANTHROPIC_API_KEY");
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
            category: AuthCategory::Provider,
            status: None,
            flow: AuthFlow::ApiKeyPrompt,
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
