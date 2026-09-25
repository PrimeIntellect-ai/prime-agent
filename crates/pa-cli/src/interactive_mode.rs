//! Interactive mode wiring: resolve the daemon socket, ensure a supervisor is
//! listening (spawning one detached, TS `daemon-launch.ts` semantics), pick
//! the session from the CLI session flags, and hand off to the pa-tui
//! interactive loop. The session keeps running in the worker after the UI
//! exits; reattaching later restores it from the same session file.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};

use crate::config;
use crate::mode::RunOptions;
use pa_tui::interactive::{InteractiveOptions, ModelSelection, SessionSelection, UiMode};

const DAEMON_STARTUP_TIMEOUT_MS: u64 = 30_000;
const DAEMON_SHUTDOWN_WAIT_MS: u64 = 5_000;

/// The startup-model resolution inputs (TS `findInitialModel`'s chain),
/// captured at task construction: the onboarding flow re-resolves the
/// model state at its own boundaries — the branch (TS
/// `isOnboardingModelReady` at flow start) and the completion gate (TS
/// re-reads `getOnboardingState` before `markOnboardingShown`) — because
/// the flow's own sign-in can change the answer.
#[derive(Clone)]
struct StartupModelProbe {
    cwd: PathBuf,
    agent_dir: PathBuf,
    cli_provider: Option<String>,
    cli_model: Option<String>,
    /// The `--models` scope pattern list, resolved against the fresh
    /// catalog on every probe.
    models: Option<Vec<String>>,
    is_continuing: bool,
    /// An explicit `--api-key` counts as configured auth (it rides the
    /// resolved model's provider as a runtime key).
    api_key: Option<String>,
}

impl StartupModelProbe {
    /// The resolution (TS `findInitialModel` + `isOnboardingModelReady`):
    /// the startup model, and whether it carries configured auth.
    fn resolve(&self) -> (Option<pa_types::ai::Model>, bool) {
        let settings = pa_core::settings::SettingsManager::create(&self.cwd, &self.agent_dir);
        let auth = pa_core::auth::AuthStorage::create(&self.agent_dir);
        let mut registry =
            pa_core::models::ModelRegistry::create(auth, self.agent_dir.join("models.json"));
        // Sync resolution on a fresh registry must adopt the on-disk private
        // authorization cache before `get_available` (same rule as the daemon
        // create path).
        registry.load_private_authorization_from_cache();
        let all: Vec<pa_types::ai::Model> = registry.get_all().to_vec();
        let available: Vec<pa_types::ai::Model> =
            registry.get_available().into_iter().cloned().collect();
        let scoped = self
            .models
            .as_deref()
            .map(|patterns| pa_core::models::resolve_model_scope_from_models(patterns, &available))
            .unwrap_or_default();
        let startup_model =
            pa_core::models::find_initial_model(&pa_core::models::InitialModelOptions {
                cli_provider: self.cli_provider.as_deref(),
                cli_model: self.cli_model.as_deref(),
                scoped_models: &scoped,
                is_continuing: self.is_continuing,
                default_provider: settings.get_default_provider(),
                default_model_id: settings.get_default_model(),
                all_models: &all,
                available_models: &available,
            });
        let ready = match &startup_model {
            Some(model) => registry.has_configured_auth(model) || self.api_key.is_some(),
            None => false,
        };
        (startup_model, ready)
    }

    /// The completion telemetry's category columns (TS
    /// `captureOnboardingCompleted`): the resolved startup model's
    /// provider category and the credential source's auth category.
    /// Best-effort — a resolution failure reports the unknown columns.
    fn telemetry_categories(&self) -> (String, String) {
        use pa_core::auth::AuthSource;
        let Some(model) = self.resolve().0 else {
            return ("none".to_string(), "unknown".to_string());
        };
        let provider_category =
            pa_core::session_engine::telemetry::provider_category(Some(&model.provider));
        let auth = pa_core::auth::AuthStorage::create(&self.agent_dir);
        let status = auth.get_auth_status(&model.provider);
        let credential = auth.get_all().credential(&model.provider);
        let auth_category = match status.source {
            // TS `telemetryAuthCategory`: the stored credential reports
            // its type.
            Some(AuthSource::Stored) => credential
                .as_ref()
                .map(|credential| credential.credential_type().to_string())
                .unwrap_or_else(|| "stored".to_string()),
            Some(AuthSource::Runtime) => "runtime_api_key".to_string(),
            Some(AuthSource::Environment) => "environment".to_string(),
            Some(AuthSource::PrimeCli) => "prime_cli".to_string(),
            Some(AuthSource::ModelsJsonKey) | Some(AuthSource::ModelsJsonCommand) => {
                "models_json".to_string()
            }
            Some(AuthSource::Fallback) => "fallback".to_string(),
            Some(AuthSource::Stale) => "stale".to_string(),
            None => "none".to_string(),
        };
        (auth_category, provider_category)
    }
}

/// Persistence for the first-run onboarding answers: the global settings
/// file (TS `setAgentTracesEnabled` / `markOnboardingShown` + flush).
struct SettingsOnboardingSink {
    cwd: PathBuf,
    agent_dir: PathBuf,
    /// When the onboarding task was created: the `onboarding completed`
    /// duration measures sink creation to completion (the TUI starts the
    /// flow right away; a fresh home answers the question, a home with a
    /// standing choice completes silently).
    created_at: std::time::Instant,
    /// The startup-model probe (the completion telemetry's category
    /// columns: the resolved startup model and its auth source).
    probe: StartupModelProbe,
}

impl pa_tui::interactive::OnboardingSink for SettingsOnboardingSink {
    fn onboarding_shown(&self) -> bool {
        pa_core::settings::SettingsManager::create(&self.cwd, &self.agent_dir)
            .get_onboarding_shown()
    }

    fn agent_traces_choice_written(&self) -> bool {
        pa_core::settings::SettingsManager::create(&self.cwd, &self.agent_dir)
            .agent_traces_choice_written()
    }

    fn set_agent_traces_enabled(&self, enabled: bool) -> Result<()> {
        let mut settings = pa_core::settings::SettingsManager::create(&self.cwd, &self.agent_dir);
        settings.set_agent_traces_enabled(enabled)
    }

    fn mark_onboarding_complete(&self) -> Result<()> {
        let mut settings = pa_core::settings::SettingsManager::create(&self.cwd, &self.agent_dir);
        settings.set_onboarding_shown(true)?;
        // `onboarding completed` (schema v1): the marker writes only on a
        // completed flow, so the outcome is always success; the auth and
        // provider categories read the resolved startup model (TS
        // `captureOnboardingCompleted`'s `getCurrentModel` + auth status
        // columns). Best-effort like all telemetry.
        if !crate::mode::telemetry_disabled(&settings) {
            let client =
                pa_core::session_engine::telemetry::build_client(&settings, &self.agent_dir);
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set(
                "duration_ms",
                serde_json::Value::from(self.created_at.elapsed().as_millis() as u64),
            );
            properties.set("outcome", serde_json::Value::from("success"));
            let (auth_category, provider_category) = self.probe.telemetry_categories();
            properties.set("auth_category", serde_json::Value::from(auth_category));
            properties.set(
                "provider_category",
                serde_json::Value::from(provider_category),
            );
            client.track("onboarding completed", properties);
        }
        Ok(())
    }
}

/// TS `shouldRunOnboarding`: first launch is defined by the settings flag
/// alone — credentials found on disk (a Prime CLI token, an API key in
/// the environment) never skip the flow, they only make the sign-in step
/// instant. The task carries the startup model state (the resolved model
/// is TS `getCurrentModel` at flow time; the readiness probe decides the
/// branch and gates the completion marker), and the provider auth surface
/// the full flow signs in through. The startup model follows the TS
/// `findInitialModel` chain — explicit flags, the `--models` scope, the
/// saved settings default, the featured default, the first available
/// model.
fn onboarding_task(
    options: &RunOptions,
    provider_auth: Option<pa_tui::provider_auth::ProviderAuthCommandsHandle>,
) -> Option<pa_tui::interactive::OnboardingTask> {
    let config = &options.config;
    let settings = pa_core::settings::SettingsManager::create(&config.cwd, &config.agent_dir);
    if settings.get_onboarding_shown() {
        return None;
    }
    let probe = StartupModelProbe {
        cwd: config.cwd.clone(),
        agent_dir: config.agent_dir.clone(),
        cli_provider: config.provider.clone(),
        cli_model: config.model.clone(),
        models: config.models.clone(),
        is_continuing: options.session.resume.is_some() || options.session.continue_recent,
        api_key: config.api_key.clone(),
    };
    let (current_model, _) = probe.resolve();
    let readiness_probe = probe.clone();
    Some(pa_tui::interactive::OnboardingTask {
        sink: std::sync::Arc::new(SettingsOnboardingSink {
            cwd: config.cwd.clone(),
            agent_dir: config.agent_dir.clone(),
            created_at: std::time::Instant::now(),
            probe,
        }),
        model_ready: std::sync::Arc::new(move || readiness_probe.resolve().1),
        current_model,
        provider_auth,
    })
}

/// `tui scroll used` / `tui exit` adoption telemetry: a one-shot client per
/// event, tracked and flushed at the emission point (the `startup`-event
/// pattern). Telemetry must never fail the session: opt-out or a broken
/// install id drops the event.
struct CliInteractionTelemetry {
    cwd: PathBuf,
    agent_dir: PathBuf,
}

impl CliInteractionTelemetry {
    /// A one-shot client, or `None` when telemetry is opted out.
    fn client(&self) -> Option<pa_telemetry::TelemetryClient> {
        let settings = pa_core::settings::SettingsManager::create(&self.cwd, &self.agent_dir);
        if crate::mode::telemetry_disabled(&settings) {
            return None;
        }
        Some(pa_core::session_engine::telemetry::build_client(
            &settings,
            &self.agent_dir,
        ))
    }
}

impl pa_tui::interactive::InteractionTelemetry for CliInteractionTelemetry {
    fn bash_shortcut_used(
        &self,
        excluded: bool,
        side_conversation: bool,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("excluded", serde_json::Value::from(excluded));
            properties.set(
                "side_conversation",
                serde_json::Value::from(side_conversation),
            );
            client.track("tui bash shortcut used", properties);
            let _ = client.shutdown().await;
        })
    }

    fn bash_bang_executed(
        &self,
        duration_bucket: &'static str,
        exit_class: &'static str,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("duration_bucket", serde_json::Value::from(duration_bucket));
            properties.set("exit_class", serde_json::Value::from(exit_class));
            client.track("tui bash bang executed", properties);
            let _ = client.shutdown().await;
        })
    }

    fn prompt_stash(
        &self,
        action: &'static str,
        had_images: bool,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("action", serde_json::Value::from(action));
            properties.set("had_images", serde_json::Value::from(had_images));
            client.track("tui prompt stash", properties);
            let _ = client.shutdown().await;
        })
    }

    fn scroll_used(
        &self,
        action: &'static str,
        resumed_following: bool,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("action", serde_json::Value::from(action));
            properties.set(
                "resumed_following",
                serde_json::Value::from(resumed_following),
            );
            client.track("tui scroll used", properties);
            let _ = client.shutdown().await;
        })
    }

    fn selection_used(&self, lines: usize) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("lines", serde_json::Value::from(lines as u64));
            client.track("tui selection used", properties);
            let _ = client.shutdown().await;
        })
    }
    fn client_exit(
        &self,
        reason: &'static str,
        turn_active: bool,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("exit_reason", serde_json::Value::from(reason));
            properties.set("turn_active", serde_json::Value::from(turn_active));
            client.track("tui exit", properties);
            let _ = client.shutdown().await;
        })
    }

    fn activity_opened(&self, kind: &'static str) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("kind", serde_json::Value::from(kind));
            client.track("tui activity opened", properties);
            let _ = client.shutdown().await;
        })
    }

    fn menu_opened(
        &self,
        menu: &'static str,
        source: &'static str,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("menu", serde_json::Value::from(menu));
            properties.set("source", serde_json::Value::from(source));
            client.track("tui menu opened", properties);
            let _ = client.shutdown().await;
        })
    }

    fn subagents_view_opened(
        &self,
        children_total: u64,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("children_total", serde_json::Value::from(children_total));
            client.track("tui subagents open", properties);
            let _ = client.shutdown().await;
        })
    }

    fn command_used(&self, command: &'static str) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        // `agent command used` (TS `captureAgentCommandUsed`): builtin
        // client commands report from the client; session commands report
        // through the session telemetry, so the two seams never double-emit.
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("command_name", serde_json::Value::from(command));
            client.track("agent command used", properties);
            let _ = client.shutdown().await;
        })
    }

    fn image_pasted(&self, mime_type: &str) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        // The returned future borrows only `self`, so the mime type rides
        // inside it by value.
        let mime_type = mime_type.to_string();
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("mime_type", serde_json::Value::from(mime_type));
            client.track("tui image pasted", properties);
            let _ = client.shutdown().await;
        })
    }

    fn queued_input(
        &self,
        lane: &'static str,
        steering_mode: String,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("lane", serde_json::Value::from(lane));
            properties.set("steering_mode", serde_json::Value::from(steering_mode));
            client.track("tui input queued", properties);
            let _ = client.shutdown().await;
        })
    }

    fn queue_edited(&self, action: &'static str) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("action", serde_json::Value::from(action));
            client.track("tui queue edited", properties);
            let _ = client.shutdown().await;
        })
    }

    fn enhanced_keys(
        &self,
        kitty: bool,
        modify_other_keys: bool,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("kitty", serde_json::Value::from(kitty));
            properties.set(
                "modify_other_keys",
                serde_json::Value::from(modify_other_keys),
            );
            client.track("tui enhanced keys", properties);
            let _ = client.shutdown().await;
        })
    }

    fn hyperlinks_active(&self, enabled: bool) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("enabled", serde_json::Value::from(enabled));
            client.track("tui hyperlinks", properties);
            let _ = client.shutdown().await;
        })
    }

    fn suspend_used(&self, outcome: &'static str) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("outcome", serde_json::Value::from(outcome));
            client.track("tui suspend used", properties);
            let _ = client.shutdown().await;
        })
    }
}

/// Run the interactive TUI attached to the daemon. Returns the exit code.
pub fn run_interactive_mode(options: &RunOptions) -> Result<i32> {
    let socket_path = resolve_socket_path(options.daemon_socket.as_deref());
    let tui_options = build_tui_options(
        options,
        socket_path,
        std::sync::Arc::new(std::sync::Mutex::new(
            pa_tui::prompt_stash::PromptStashStore::default(),
        )),
    )?;
    // Telemetry disclosure (TS agent-session-services): once per
    // installation, only after onboarding marked itself shown (a first
    // interactive run belongs to the onboarding screen; the notice surfaces
    // on the next launch). Divergence from TS: the TS product renders it as
    // (a session diagnostic in the TUI; the Rust build prints it to stderr
    // before the TUI starts, which keeps the same text visible without a
    // daemon-side diagnostics round-trip).
    if !tui_options.telemetry_disabled.unwrap_or(false) {
        let mut settings = pa_core::settings::SettingsManager::create(
            &options.config.cwd,
            &options.config.agent_dir,
        );
        if settings.get_onboarding_shown() && !settings.get_telemetry_notice_shown() {
            eprintln!(
                "Prime Agent sends pseudonymous usage and performance metrics without prompts, responses, tool content, file paths, or repository data. Disable this with telemetry.enabled=false, PRIME_AGENT_TELEMETRY=0, DO_NOT_TRACK=1, or offline mode."
            );
            if let Err(error) = settings.set_telemetry_notice_shown(true) {
                eprintln!("Warning: could not persist the telemetry notice: {error}");
            }
        }
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("build the interactive runtime")?;
    let startup_started = std::time::Instant::now();
    runtime.block_on(async {
        ensure_daemon_running(&tui_options.socket_path, &tui_options.cwd).await?;
        // `startup` (schema v1): process entry to a ready interactive
        // session environment (daemon listening). Emitted through a
        // one-shot client that flushes immediately; the session's own
        // telemetry rides the daemon worker.
        if !options.config.telemetry_disabled {
            let agent_dir = options.config.agent_dir.clone();
            let settings =
                pa_core::settings::SettingsManager::create(&options.config.cwd, &agent_dir);
            let client = pa_core::session_engine::telemetry::build_client(&settings, &agent_dir);
            let daemon_ready_ms = startup_started.elapsed().as_millis() as u64;
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("duration_ms", serde_json::Value::from(daemon_ready_ms));
            let mut phase_timings = pa_telemetry::Properties::new();
            phase_timings.set("daemon_ready", serde_json::Value::from(daemon_ready_ms));
            properties.set_map("phase_timings", &phase_timings);
            client.track("startup", properties);
            let _ = client.shutdown().await;
        }
        // `prime-agent agents` and bare `--resume` open the agents view
        // (TS `agentsViewRequested`); the view then opens sessions, and a
        // session exits back into the view until the user exits it. TS gates
        // the explicit `agents` request on completed onboarding (a fresh
        // install shows the first-run notice first); bare `--resume` opens
        // the view regardless. `--continue` joins them when a candidate
        // session exists: the view opens preselected on the newest saved
        // session for the cwd (the notice names it) so the user confirms
        // what continues instead of a blind newest-resume.
        let continue_view = continue_recent_view(options, tui_options.onboarding.is_some());
        let agents_view = options.session.resume_bare
            || (options.agents_view_requested && tui_options.onboarding.is_none())
            || continue_view.is_some();
        if agents_view {
            let (anchor, notice) = continue_view.map_or((None, None), |view| {
                (Some(view.session_id), Some(view.notice))
            });
            run_agents_view_flow(tui_options, anchor, notice).await
        } else {
            let outcome =
                pa_tui::interactive::run_interactive(tui_options.clone(), UiMode::Terminal).await?;
            // TS `main.ts`: a direct session run closes into the agents view
            // when the exit came through agents-back or `/resume`
            // (`launchAgentsView` anchored on the session just left); every
            // other exit (ctrl+c/ctrl+d, `/quit`) ends the process.
            if outcome.return_to_agents_view {
                // A startup attach that fell back to the view has no session
                // identity to anchor on; its notice seeds the view's status
                // line instead.
                let anchor = (!outcome.session_id.is_empty()).then(|| outcome.session_id.clone());
                run_agents_view_flow(tui_options, anchor, outcome.agents_view_notice).await
            } else {
                print_resume_hint(&outcome.resume_hint);
                Ok(())
            }
        }
    })?;
    // tmux (verified on 3.2a) can drop the pane's final output when the
    // process dies immediately after writing it: the just-printed resume
    // hint — and the tail of the exit flush — races the pane-death
    // handling and the dead pane comes up blank. Holding the process
    // briefly after the last write lets the terminal apply it first. The
    // TS product wins this race only by exiting slower (its input drain
    // plus node teardown); the bound stays far inside the exit-within-1s
    // contract.
    std::thread::sleep(Duration::from_millis(300));
    Ok(0)
}

/// TS `shutdown` prints the dim resume hint (`formatResumeHint`) to stdout
/// after the TUI is restored; agents-view returns suppress it. Dim is the
/// TS `chalk.dim` styling (`ESC[2m` ... `ESC[22m`).
fn print_resume_hint(hint: &Option<String>) {
    if let Some(hint) = hint {
        println!("\x1b[2m{hint}\x1b[22m");
    }
}

/// The agents-view loop: open the view, run the session it opens, and return
/// to the view when the session detaches through agents-back or bare
/// `/resume` (TS `InteractiveMode.run` returning `agents_view`). Every other
/// session exit — ctrl+c/ctrl+d, `/quit`, `/exit` — ends the whole app (TS
/// `shutdown()` exits the process instead of reopening the view). A
/// `/resume <selector>` chain runs its target before the loop decides again.
async fn run_agents_view_flow(
    base: InteractiveOptions,
    anchor: Option<String>,
    notice: Option<String>,
) -> Result<()> {
    let mut anchor = anchor;
    // The flow's roster connection (TS `AgentsViewPersistentState.rosterClient`):
    // every view run in this loop reuses it, and a chat run hands it back,
    // so a switch back from a chat skips the connect + hello handshake.
    let mut roster_link: Option<pa_tui::agents_view::AgentsViewLink> = None;
    // The view/session loop's carried state (TS `AgentsViewPersistentState`):
    // a stack of scope frames (the scope plus the return chat each was
    // opened from), the typed query, the drilled-in row's ancestors to
    // re-expand, and the selected row's identity and key.
    let mut frames: Vec<(
        pa_tui::agents_view::AgentsViewScope,
        Option<SessionSelection>,
    )> = Vec::new();
    let mut query: Option<String> = None;
    let mut expanded_ancestors: Vec<String> = Vec::new();
    let mut selected_row_identity: Option<String> = None;
    let mut selected_key: Option<pa_tui::agents_view::AgentsViewSelectionKey> = None;
    let mut status_message: Option<String> = notice;
    loop {
        let view_options = pa_tui::agents_view::AgentsViewOptions {
            socket_path: base.socket_path.clone(),
            cwd: base.cwd.clone(),
            session_dir: base.session_dir.clone(),
            theme: base.theme.clone(),
            version: base.version.clone(),
            anchor_session_id: anchor.clone(),
            scope: frames.last().map(|(scope, _)| scope.clone()),
            query: query.clone(),
            expanded_ancestors: expanded_ancestors.clone(),
            selected_row_identity: selected_row_identity.clone(),
            selected_key: selected_key.clone(),
            status_message: status_message.take(),
            // The view dispatches every action through the same effective
            // bindings as the session it opened from (TS
            // `AgentsViewMode.keybindings`).
            keybindings: base.keybindings.clone(),
            // TS `AgentsViewMode` constructs its TUI with the live
            // `settingsManager.getShowHardwareCursor()` (default false).
            show_hardware_cursor: base
                .client_settings
                .as_ref()
                .is_some_and(|settings| settings.show_hardware_cursor()),
        };
        let view_run = pa_tui::agents_view::run_agents_view(
            view_options,
            pa_tui::agents_view::AgentsViewUiMode::Terminal,
            roster_link.take(),
        )
        .await?;
        let view = view_run.outcome;
        // A handoff to a chat parked the connection for this loop's next
        // view run; a selection-less exit closed it already.
        roster_link = view_run.link;
        // A dropped scope root or the view's parent key pops the frame (TS
        // `resolveAgentsViewScopeFrames` / the `scope_back` arm), so a later
        // agents-back lands in the parent scope; both clear the query.
        let scope_frame_popped = view.scope_dropped || view.scope_popped;
        if scope_frame_popped {
            frames.pop();
        }
        let Some(selection) = view.selection else {
            return Ok(());
        };
        expanded_ancestors = view.expanded_ancestors.clone();
        selected_row_identity = view.selected_row_identity.clone();
        selected_key = view.selected_key.clone();
        status_message = view.status_message.clone();
        query = if scope_frame_popped { None } else { view.query };
        // The opened row's depth metadata rides the session run (TS
        // `sessionDepth`/`sessionHasChildren`): a drilled-in child renders
        // its `depth N` tray label.
        let mut session_options = base.clone();
        session_options.session = selection;
        session_options.session_rlm_depth = view.opened_rlm_depth;
        session_options.session_has_children = view.opened_has_children;
        let outcome =
            pa_tui::interactive::run_interactive(session_options, UiMode::Terminal).await?;
        if !outcome.session_id.is_empty() {
            anchor = Some(outcome.session_id.clone());
        }
        if let Some(notice) = &outcome.agents_view_notice {
            status_message = Some(notice.clone());
        }
        if !outcome.return_to_agents_view {
            print_resume_hint(&outcome.resume_hint);
            if let Some(link) = roster_link.take() {
                link.close();
            }
            return Ok(());
        }
        if let Some(scope) = outcome.agents_view_scope {
            // The session's subagent summary line opened the agents view
            // scoped to its subtree: push a frame with the session as the
            // return chat (TS `transitionAgentsViewScope` push arm) and
            // clear the query — the scope already narrows the list, and a
            // filter typed to find the session would hide the subtree.
            frames.retain(|(frame, _)| frame.session_id != scope.session_id);
            frames.push((
                scope,
                Some(SessionSelection::Attach(outcome.active_session_id.clone())),
            ));
            query = None;
        }
        // `/resume <selector>` routes straight to that session before the
        // loop reopens the view.
        let mut pending = outcome.selection_request;
        while let Some(selection) = pending.take() {
            let mut next = base.clone();
            next.session = selection;
            let outcome = pa_tui::interactive::run_interactive(next, UiMode::Terminal).await?;
            if !outcome.session_id.is_empty() {
                anchor = Some(outcome.session_id.clone());
            }
            if let Some(notice) = &outcome.agents_view_notice {
                status_message = Some(notice.clone());
            }
            if !outcome.return_to_agents_view {
                print_resume_hint(&outcome.resume_hint);
                if let Some(link) = roster_link.take() {
                    link.close();
                }
                return Ok(());
            }
            if let Some(scope) = outcome.agents_view_scope {
                frames.retain(|(frame, _)| frame.session_id != scope.session_id);
                frames.push((
                    scope,
                    Some(SessionSelection::Attach(outcome.active_session_id.clone())),
                ));
                query = None;
            }
            pending = outcome.selection_request;
        }
    }
}

/// `--daemon-socket` value, the `PRIME_AGENT_DAEMON_SOCKET` environment,
/// or the per-user default socket path (precedence in that order).
pub fn resolve_socket_path(daemon_socket: Option<&str>) -> PathBuf {
    config::resolve_daemon_socket_path(daemon_socket)
}

fn build_tui_options(
    options: &RunOptions,
    socket_path: PathBuf,
    prompt_stash: std::sync::Arc<std::sync::Mutex<pa_tui::prompt_stash::PromptStashStore>>,
) -> Result<InteractiveOptions> {
    let config = &options.config;
    if options.session.fork.is_some() {
        // A fork must copy the target session into a new file before the
        // daemon can open it; wiring the copy is tracked with session-queue
        // work. Refuse instead of silently resuming the original file.
        return Err(anyhow!(
            "session forking is not wired into the daemon yet; use --resume to reopen the session"
        ));
    }
    let session_dir = options
        .session
        .session_dir
        .clone()
        .or_else(|| Some(config.agent_dir.join("sessions")));
    // TS startup migrations rewrite legacy keybinding ids in
    // `keybindings.json` before the manager loads them
    // (`migrateKeybindingsConfigFile` in `runMigrations`).
    if let Err(error) = pa_tui::keybindings::migrate_keybindings_file(&config.agent_dir) {
        // A failed migration never blocks startup: the manager below
        // falls back to the previous file contents (or the defaults).
        eprintln!("Warning: could not migrate keybindings: {error:#}");
    }
    // TS `KeybindingsManager.create(agentDir)`: the user's
    // `keybindings.json` merged over the shipped defaults drives the TUI.
    let keybindings = pa_tui::keybindings::KeybindingsManager::create(&config.agent_dir);
    // Test seam: a scripted faux daemon session (same contract as the print
    // runtime). Verification harness only; never set by the product.
    let script_path = std::env::var_os("PRIME_AGENT_FAUX_SCRIPT").map(PathBuf::from);
    let session = session_selection(&options.session, &session_dir)?;
    // The chat markdown code-block indent reads the effective settings on
    // startup (TS `getCodeBlockIndent` -> `getMarkdownThemeWithSettings`).
    let settings = pa_core::settings::SettingsManager::create(&config.cwd, &config.agent_dir);
    let code_block_indent = settings.get_code_block_indent();
    let show_images = settings.get_show_images();
    let fullscreen_mouse = settings.get_fullscreen_mouse();
    // The `/tree` selector's initial filter and the branch-summary prompt
    // skip read the same settings the TS interactive mode reads at
    // startup.
    let tree_filter_mode = settings.get_tree_filter_mode();
    let branch_summary_skip_prompt = settings.get_branch_summary_skip_prompt();
    // The `/model` picker catalog: a startup snapshot of the available
    // models (same registry and private-authorization cache adoption as
    // the startup-model chain; entitlement refreshes run daemon-side, so
    // the picker works off the snapshot until the daemon's
    // `get_model_catalog` response lands). models.json entries are part of
    // the available catalog, so configured custom models list in the
    // picker; the picker itself owns the TS selector order.
    let auth = pa_core::auth::AuthStorage::create(&config.agent_dir);
    let mut registry =
        pa_core::models::ModelRegistry::create(auth, config.agent_dir.join("models.json"));
    registry.load_private_authorization_from_cache();
    let catalog: Vec<pa_types::ai::Model> = registry.get_available().into_iter().cloned().collect();
    let configured_providers: std::collections::HashSet<String> =
        catalog.iter().map(|model| model.provider.clone()).collect();
    let settings = pa_core::settings::SettingsManager::create(&config.cwd, &config.agent_dir);
    let recent = settings.get_recent_models();
    let default_thinking_level = settings
        .get_default_thinking_level()
        .map(|level| level.model_level().wire_name().to_string());
    // `/login` + `/logout`: the provider auth flows (the API-key store,
    // the MCP device flow, the Prime Inference login, the provider
    // catalog) — one handle serves the commands and the onboarding flow's
    // sign-in steps.
    let provider_auth = pa_tui::provider_auth::ProviderAuthCommandsHandle(std::sync::Arc::new(
        crate::provider_login::ProviderAuth::new(config.cwd.clone(), config.agent_dir.clone()),
    ));
    Ok(InteractiveOptions {
        code_block_indent,
        tree_filter_mode,
        branch_summary_skip_prompt,
        model_catalog: catalog,
        model_configured_providers: configured_providers,
        model_recent_models: recent,
        default_thinking_level,
        socket_path,
        cwd: config.cwd.clone(),
        session_dir,
        script_path,
        // Explicit CLI model flags ride every create request (TS
        // runtime-config propagation): the daemon worker must treat them as
        // authoritative, not fall back to a process-wide model.
        model_selection: ModelSelection {
            provider: config.provider.clone(),
            model: config.model.clone(),
            api_key: config.api_key.clone(),
            // The `--thinking` flag rides the same create-config path:
            // the worker clamps it to the model's supported levels.
            thinking: config.thinking,
        },
        no_session: options.session.no_session,
        session,
        initial_message: options.initial_message.clone(),
        show_images,
        fullscreen_mouse,
        // TS startup reads the settings theme (`getTheme() || "prime"`).
        theme: settings.get_theme().map(str::to_string).unwrap_or_default(),
        // The client-settings seam the interactive commands persist
        // through (`/settings`, `/fullscreen`).
        client_settings: Some(crate::client_settings::CliClientSettings::new(
            config.cwd.clone(),
            config.agent_dir.clone(),
        )),
        version: crate::config::version().to_string(),
        // TS `shouldRunOnboarding`: the settings flag alone mounts the
        // task; the carried startup-model state decides the branch and
        // gates the completion marker, and the auth handle serves the
        // not-ready branch's sign-in steps.
        onboarding: onboarding_task(options, Some(provider_auth.clone())),
        // Only Some(true) rides the wire (TS `telemetryDisabled`).
        telemetry_disabled: config.telemetry_disabled.then_some(true),
        // `/mcp login` / `/mcp logout`: the client-side auth flows run in
        // this process (the TS interactive client's placement) and persist
        // through the shared auth store the daemon's sessions read.
        client_auth: Some(pa_tui::client_auth::ClientAuthCommandsHandle(
            std::sync::Arc::new(crate::mcp_login::TerminalMcpAuth::new(
                config.cwd.clone(),
                config.agent_dir.clone(),
            )),
        )),
        // `/traces`: the settings flag and the resolved credential the
        // status block shows; the upload subsystem itself stays unported.
        traces: Some(pa_tui::traces::TracesCommandsHandle(std::sync::Arc::new(
            crate::client_traces::ClientTraces::new(config.cwd.clone(), config.agent_dir.clone()),
        ))),
        // `/update`: the CLI child runner and the post-update relaunch.
        update_commands: Some(pa_tui::update_command::UpdateCommandsHandle(
            std::sync::Arc::new(crate::client_update::ClientUpdate),
        )),
        // `/login` + `/logout`: the provider auth flows (the API-key store,
        // the MCP device flow, the provider catalog).
        provider_auth: Some(provider_auth),
        telemetry: Some(std::sync::Arc::new(CliInteractionTelemetry {
            cwd: config.cwd.clone(),
            agent_dir: config.agent_dir.clone(),
        })),
        keybindings,
        // The process-wide prompt stash store (TS `ClientPromptStashStore`
        // lives in `main.ts`'s invocation scope): one store per process, so
        // the agents-view loop (view -> chat -> view) keeps every stashed
        // draft alive across its chat runs.
        prompt_stash,
        // RLM depth metadata comes from the agents view when it opens a row
        // (TS `sessionDepth`/`sessionHasChildren`); a direct CLI session is
        // a root run.
        session_rlm_depth: None,
        session_has_children: false,
    })
}

/// Map the CLI session flags onto the TUI session selection (the TS order:
/// explicit `--resume` selector, then a fresh session). `--continue` never
/// maps to a resume: it surfaces its candidate through the agents view
/// ([`continue_recent_view`]) and falls through to the fresh-session run
/// here.
fn session_selection(
    session: &crate::mode::SessionOptions,
    session_dir: &Option<PathBuf>,
) -> Result<SessionSelection> {
    if let Some(selector) = &session.resume {
        let default_dir = config::get_agent_dir().join("sessions");
        let dir = session_dir.as_deref().unwrap_or(&default_dir);
        return Ok(resolve_resume_selector(selector, dir));
    }
    Ok(SessionSelection::New)
}

/// The `--continue` launch's agents-view target: the newest saved session
/// for the cwd (the candidate TS `SessionManager.continueRecent` silently
/// reopens) plus the status-line notice that names it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ContinueRecentView {
    /// The candidate's session id: the view preselects (anchors on) its row.
    session_id: String,
    notice: String,
}

/// Resolve the `--continue` launch into an agents-view opening. The launch
/// never blind-resumes the newest session: on a shared session dir that
/// could be any session (an orchestrator's), and reopening it would revive
/// its context and scheduled jobs without the user ever naming it. The view
/// shows the candidate preselected and the user confirms what continues (a
/// sanctioned divergence: TS `SessionManager.continueRecent` reopens the
/// candidate silently). `None` falls through to the direct fresh-session
/// run: not a bare `--continue` launch (an explicit `--resume` selector or
/// `--no-session` owns the selection first, the TS flag order), a pending
/// onboarding (the first-run notice owns the startup, like the explicit
/// `agents` request), or no saved session for the cwd (the fresh-session
/// fallback TS `continueRecent` itself takes).
fn continue_recent_view(
    options: &RunOptions,
    onboarding_pending: bool,
) -> Option<ContinueRecentView> {
    if !options.session.continue_recent
        || options.session.resume.is_some()
        || options.session.no_session
        || onboarding_pending
    {
        return None;
    }
    let session_dir = options
        .session
        .session_dir
        .clone()
        .unwrap_or_else(|| options.config.agent_dir.join("sessions"));
    let cwd = options.config.cwd.clone();
    let path = pa_core::session::discovery::find_most_recent_session_for_cwd(&session_dir, &cwd)?;
    let header = pa_core::session::manager::read_session_header(&path)?;
    if header.id.is_empty() {
        return None;
    }
    Some(ContinueRecentView {
        session_id: header.id.clone(),
        notice: format!(
            "Most recent session for this directory: {} — Enter continues it, or pick another session.",
            header.id
        ),
    })
}

/// `--resume <selector>`: an existing session file path, a `<id>.jsonl` under
/// the sessions dir, or a live daemon session id (attach).
fn resolve_resume_selector(selector: &str, session_dir: &Path) -> SessionSelection {
    let path = config::expand_tilde_path(selector);
    if path.is_file() {
        return SessionSelection::Resume(path);
    }
    let candidate = session_dir.join(format!("{selector}.jsonl"));
    if candidate.is_file() {
        return SessionSelection::Resume(candidate);
    }
    SessionSelection::Attach(selector.to_string())
}

/// The daemon probe outcome (TS `DaemonVersionProbe`).
enum DaemonProbe {
    /// No socket answered.
    Absent,
    /// A supervisor answered whose protocol/schema matches this build.
    Current,
    /// A supervisor answered with a different protocol/schema.
    Stale(pa_tui::daemon_client::DaemonClient),
}

/// Probe the socket once: connect, read the hello, and classify it.
async fn probe_daemon(socket_path: &Path) -> DaemonProbe {
    let Ok((client, _events)) = pa_tui::daemon_client::DaemonClient::connect(socket_path).await
    else {
        return DaemonProbe::Absent;
    };
    let hello = client.hello();
    let current = hello.get("protocol").and_then(|p| p.get("version"))
        == Some(&serde_json::json!(
            pa_types::daemon::DAEMON_PROTOCOL_VERSION
        ))
        && hello.get("schemaId") == Some(&serde_json::json!(pa_types::daemon::DAEMON_SCHEMA_ID));
    if current {
        client.close();
        DaemonProbe::Current
    } else {
        DaemonProbe::Stale(client)
    }
}

/// Ensure a current daemon is listening on `socket_path`, spawning this
/// executable in `--mode daemon` when it is not (TS `ensureDaemonRunning`:
/// probe; a stale idle daemon is shut down, a busy one refuses replacement).
pub async fn ensure_daemon_running(socket_path: &Path, spawn_cwd: &Path) -> Result<()> {
    match probe_daemon(socket_path).await {
        DaemonProbe::Current => return Ok(()),
        DaemonProbe::Stale(client) => shutdown_stale_daemon(client, socket_path).await?,
        DaemonProbe::Absent => {}
    }
    let exe = std::env::current_exe().context("resolve the prime-agent executable")?;
    ensure_daemon_running_with(&exe, socket_path, spawn_cwd).await
}

/// [`ensure_daemon_running`] with an explicit supervisor executable (the
/// product path uses this process's own binary, TS parity).
pub async fn ensure_daemon_running_with(
    exe: &Path,
    socket_path: &Path,
    spawn_cwd: &Path,
) -> Result<()> {
    match probe_daemon(socket_path).await {
        DaemonProbe::Current => return Ok(()),
        DaemonProbe::Stale(client) => {
            // A stale daemon appeared between the caller's check and here:
            // fall through to the spawn path after refusing busy ones.
            client.close();
        }
        DaemonProbe::Absent => {}
    }
    spawn_supervisor_detached(socket_path, spawn_cwd, exe)?;
    let deadline = Instant::now() + Duration::from_millis(DAEMON_STARTUP_TIMEOUT_MS);
    loop {
        match probe_daemon(socket_path).await {
            DaemonProbe::Current => return Ok(()),
            DaemonProbe::Stale(client) => {
                // A concurrent launcher won the socket with a build whose
                // protocol matches ours at connect time but failed the
                // schema check: re-probe before deciding.
                client.close();
            }
            DaemonProbe::Absent => {}
        }
        if Instant::now() > deadline {
            return Err(anyhow!(
                "Timed out waiting for the Prime Agent daemon to start on {}. Run: prime-agent shutdown --force, then retry the original command.",
                socket_path.display()
            ));
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Shut a stale daemon down when no session is busy (TS
/// `shutdownStaleDaemonIfNotBusy`); a busy one refuses replacement.
async fn shutdown_stale_daemon(
    client: pa_tui::daemon_client::DaemonClient,
    socket_path: &Path,
) -> Result<()> {
    let sessions = client
        .request_ok(pa_types::daemon::DaemonCommand::List {
            id: None,
            all: None,
            cwd: None,
            session_dir: None,
            include_client_owned: None,
            rest: Default::default(),
        })
        .await;
    let busy = sessions.map_or(true, |data| {
        data.get("sessions")
            .and_then(serde_json::Value::as_array)
            .is_none_or(|rows| {
                rows.iter()
                    .any(|row| row.get("isSessionActive") == Some(&serde_json::json!(true)))
            })
    });
    client.close();
    if busy {
        return Err(anyhow!(
            "An incompatible Prime Agent daemon is running on {}.\n\nRun:\n  prime-agent shutdown --force\n\nThen retry the original command (the running daemon has active work).",
            socket_path.display()
        ));
    }
    // Idle: replace it.
    if let Ok((client, _)) = pa_tui::daemon_client::DaemonClient::connect(socket_path).await {
        let _ = client
            .request_ok(pa_types::daemon::DaemonCommand::Shutdown {
                id: None,
                force: None,
                rest: Default::default(),
            })
            .await;
        client.close();
    }
    wait_for_socket_gone(socket_path).await;
    Ok(())
}

/// Wait until nothing accepts connections on the socket (bounded).
async fn wait_for_socket_gone(socket_path: &Path) -> bool {
    let deadline = Instant::now() + Duration::from_millis(DAEMON_SHUTDOWN_WAIT_MS);
    while Instant::now() < deadline {
        if !pa_daemon::socket::can_connect(socket_path, Duration::from_millis(250)).await {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    false
}

/// Spawn a detached supervisor on `socket_path` (TS spawns its own entrypoint
/// with `--mode daemon --daemon-socket`; the child outlives this CLI).
fn spawn_supervisor_detached(socket_path: &Path, spawn_cwd: &Path, exe: &Path) -> Result<()> {
    let mut command = Command::new(exe);
    command
        .args(["--mode", "daemon", "--daemon-socket"])
        .arg(socket_path)
        .current_dir(spawn_cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Strip inherited worker/supervisor role env vars so the spawned
        // supervisor never starts in worker mode (a CLI running inside a
        // daemon worker would otherwise launch a supervisor that listens but
        // never handshakes) — the TS launcher deletes the same set.
        .env_remove(pa_daemon::worker::WORKER_ROLE_ENV)
        .env_remove(pa_daemon::worker::WORKER_TOKEN_ENV)
        .env_remove(pa_daemon::worker::WORKER_ACTIVE_SESSION_ID_ENV)
        .env_remove(pa_daemon::worker::WORKER_RECOVERY_JOURNAL_ENV)
        .env_remove(pa_daemon::worker::WORKER_SUPERVISOR_SOCKET_ENV)
        .env_remove(pa_daemon::worker::WORKER_SOCKET_ENV)
        .env_remove(pa_daemon::worker::WORKER_INSTANCE_ID_ENV)
        .env_remove(pa_daemon::worker::WORKER_SCRIPT_ENV)
        // A lease owner id inherited from an ancestor (a CLI running
        // inside a worker's env) would name a stale session in every
        // lease this daemon's workers write — TS `daemon-launch.ts`
        // deletes the same var before spawning the supervisor.
        .env_remove(pa_daemon::lease::SESSION_LEASE_OWNER_ID_ENV);
    // Detached: own process group, reaped by init, survives this CLI.
    pa_core::platform::process::set_new_process_group(&mut command);
    command
        .spawn()
        .with_context(|| format!("spawn the Prime Agent daemon on {}", socket_path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    // The sink's answers flow through the pa-tui trait; the tests call the
    // trait methods directly (the impl header alone does not import them).
    use pa_tui::interactive::OnboardingSink;

    #[test]
    fn session_flags_map_to_selections() {
        let mut session = crate::mode::SessionOptions::default();
        let dir = tempfile::TempDir::new().expect("temp dir");
        let session_dir = dir.path().join("sessions");
        std::fs::create_dir_all(&session_dir).expect("sessions dir");
        assert_eq!(
            session_selection(&session, &Some(session_dir.clone())).unwrap(),
            SessionSelection::New
        );
        // `--continue` never maps to a resume: the continue-recent launch
        // resolves its candidate through the agents view (see
        // `continue_recent_view`) or falls through to a fresh session.
        session.continue_recent = true;
        assert_eq!(
            session_selection(&session, &Some(session_dir.clone())).unwrap(),
            SessionSelection::New
        );
        session.continue_recent = false;
        session.resume = Some("a1b2c3".to_string());
        // A bare selector that is not a file attaches a live session id.
        assert_eq!(
            session_selection(&session, &Some(session_dir.clone())).unwrap(),
            SessionSelection::Attach("a1b2c3".to_string())
        );
        // An id with a saved file under the sessions dir reopens the file.
        let saved = session_dir.join("deadbeefcafe.jsonl");
        std::fs::write(&saved, "{}\n").expect("write file");
        session.resume = Some("deadbeefcafe".to_string());
        assert_eq!(
            session_selection(&session, &Some(session_dir.clone())).unwrap(),
            SessionSelection::Resume(saved)
        );
        // An explicit file path reopens that session file.
        let file = dir.path().join("saved.jsonl");
        std::fs::write(&file, "{}\n").expect("write file");
        session.resume = Some(file.to_string_lossy().to_string());
        assert_eq!(
            session_selection(&session, &Some(session_dir)).unwrap(),
            SessionSelection::Resume(file)
        );
    }

    fn run_options_for_continue(dir: &std::path::Path) -> RunOptions {
        use crate::mode::{AppMode, RuntimeConfig};
        RunOptions {
            app_mode: AppMode::Interactive,
            config: RuntimeConfig {
                cwd: dir.to_path_buf(),
                agent_dir: dir.join("agent"),
                ..Default::default()
            },
            session: Default::default(),
            messages: Vec::new(),
            file_args: Vec::new(),
            daemon_socket: None,
            list_models: None,
            initial_message: None,
            initial_images: Vec::new(),
            verbose: false,
            offline: false,
            agents_view_requested: false,
            attach_agent: None,
        }
    }

    /// A saved session file the cwd-scoped scans resolve: the same shape
    /// `SessionFile::create` writes (header with id + cwd).
    fn seed_saved_session(
        session_dir: &std::path::Path,
        id: &str,
        cwd: &std::path::Path,
    ) -> std::path::PathBuf {
        use std::io::Write;
        std::fs::create_dir_all(session_dir).expect("sessions dir");
        let path = session_dir.join(format!("{id}.jsonl"));
        let mut file = std::fs::File::create(&path).expect("create session file");
        let header = serde_json::json!({
            "type": "session", "id": id,
            "cwd": cwd.display().to_string(),
            "timestamp": "2024-01-01T00:00:00.000Z", "version": 3,
        });
        writeln!(file, "{header}").expect("write header");
        path
    }

    /// `--continue` surfaces the newest saved session for the cwd as the
    /// preselected agents-view target, never as a direct resume.
    #[test]
    fn continue_recent_targets_the_newest_saved_session_for_the_cwd() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let session_dir = agent_dir.join("sessions");
        seed_saved_session(&session_dir, "old0000000000000000000000000001", dir.path());
        // The newest file: written last, matching cwd.
        let candidate =
            seed_saved_session(&session_dir, "newest00000000000000000000000001", dir.path());
        // A session from another cwd must never be the candidate.
        let other_cwd = tempfile::TempDir::new().expect("other cwd");
        seed_saved_session(
            &session_dir,
            "foreign0000000000000000000000001",
            other_cwd.path(),
        );

        // Same mtime granularity as the write: nudge the candidate forward.
        let future = std::time::SystemTime::now() + std::time::Duration::from_mins(1);
        let handle = std::fs::File::options()
            .append(true)
            .open(&candidate)
            .expect("open candidate");
        handle.set_modified(future).expect("nudge mtime");

        let mut options = run_options_for_continue(dir.path());
        options.session.continue_recent = true;
        options.session.session_dir = Some(session_dir);
        let view = continue_recent_view(&options, false).expect("candidate resolves");
        assert_eq!(
            view.session_id, "newest00000000000000000000000001",
            "the newest saved session for the cwd is the preselected row"
        );
        assert!(
            view.notice.contains("newest00000000000000000000000001"),
            "the notice names the candidate: {}",
            view.notice
        );
        assert!(
            candidate.exists(),
            "resolution only reads the candidate file"
        );
    }

    /// Without a saved session for the cwd, `--continue` falls through to the
    /// fresh-session run (TS `continueRecent`'s own fallback).
    #[test]
    fn continue_recent_without_a_candidate_opens_a_fresh_session() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let session_dir = agent_dir.join("sessions");
        // Only a foreign-cwd session exists: no candidate for this cwd.
        let other_cwd = tempfile::TempDir::new().expect("other cwd");
        seed_saved_session(
            &session_dir,
            "foreign0000000000000000000000001",
            other_cwd.path(),
        );

        let mut options = run_options_for_continue(dir.path());
        options.session.continue_recent = true;
        options.session.session_dir = Some(session_dir);
        assert!(
            continue_recent_view(&options, false).is_none(),
            "no candidate: the launch opens a fresh session, not the view"
        );
    }

    /// An explicit `--resume` selector or `--no-session` owns the selection
    /// first (the TS flag order): `--continue` never shadows them with the
    /// agents view.
    #[test]
    fn continue_recent_defers_to_resume_and_no_session() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let session_dir = agent_dir.join("sessions");
        seed_saved_session(&session_dir, "newest00000000000000000000000001", dir.path());

        let mut options = run_options_for_continue(dir.path());
        options.session.session_dir = Some(session_dir);
        options.session.continue_recent = true;
        assert!(
            continue_recent_view(&options, false).is_some(),
            "a bare --continue opens the view preselected on the candidate"
        );
        options.session.resume = Some("named-session".to_string());
        assert!(
            continue_recent_view(&options, false).is_none(),
            "an explicit --resume selector wins over --continue"
        );
        options.session.resume = None;
        options.session.no_session = true;
        assert!(
            continue_recent_view(&options, false).is_none(),
            "--no-session owns the launch: nothing to continue"
        );
    }

    /// A pending onboarding keeps the startup (the first-run notice owns the
    /// launch), and a non-continue launch never opens the view.
    #[test]
    fn continue_recent_view_gates_on_onboarding_and_the_flag() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let session_dir = agent_dir.join("sessions");
        seed_saved_session(&session_dir, "newest00000000000000000000000001", dir.path());

        let mut options = run_options_for_continue(dir.path());
        options.session.session_dir = Some(session_dir);
        assert!(
            continue_recent_view(&options, false).is_none(),
            "a non-continue launch never opens the agents view through this path"
        );
        options.session.continue_recent = true;
        assert!(
            continue_recent_view(&options, true).is_none(),
            "a pending onboarding keeps the first-run startup"
        );
        assert!(
            continue_recent_view(&options, false).is_some(),
            "a completed onboarding opens the view preselected on the candidate"
        );
    }

    #[test]
    fn onboarding_gate_follows_settings_and_auth() {
        use crate::mode::{AppMode, RuntimeConfig};

        fn run_options(dir: &std::path::Path) -> RunOptions {
            RunOptions {
                app_mode: AppMode::Interactive,
                config: RuntimeConfig {
                    cwd: dir.to_path_buf(),
                    agent_dir: dir.join("agent"),
                    ..Default::default()
                },
                session: Default::default(),
                messages: Vec::new(),
                file_args: Vec::new(),
                daemon_socket: None,
                list_models: None,
                initial_message: None,
                initial_images: Vec::new(),
                verbose: false,
                offline: false,
                agents_view_requested: false,
                attach_agent: None,
            }
        }

        let dir = tempfile::TempDir::new().expect("temp dir");
        let agent = dir.path().join("agent");
        std::fs::create_dir_all(&agent).expect("agent dir");

        // A completed onboarding never reopens, regardless of model state.
        let mut settings = pa_core::settings::SettingsManager::create(dir.path(), &agent);
        settings.set_onboarding_shown(true).expect("set flag");
        let options = run_options(dir.path());
        assert!(onboarding_task(&options, None).is_none());
        // Back to a first run for the readiness checks below.
        settings.set_onboarding_shown(false).expect("reset flag");

        // Flagless launch: a models.json provider key + saved default model
        // resolve the startup model, so the onboarding task mounts (TS
        // `isOnboardingModelReady` over the `findInitialModel` chain); on a
        // fresh home it completes silently (no trace question).
        std::fs::write(
            agent.join("models.json"),
            r#"{ "providers": {
                "onboard-test": {
                    "baseUrl": "https://onboard.test", "apiKey": "sk-onboard",
                    "api": "openai-completions",
                    "models": [ { "id": "m1", "name": "M1" } ]
                },
                "onboard-naked": {
                    "baseUrl": "https://naked.test",
                    // Present (custom models require "apiKey", same as TS)
                    // but the `!command` resolves to no credential, so the
                    // provider stays unauthorized.
                    "apiKey": "!exit 1",
                    "api": "openai-completions",
                    "models": [ { "id": "m2", "name": "M2" } ]
                }
            } }"#,
        )
        .expect("models.json");
        let mut settings = pa_core::settings::SettingsManager::create(dir.path(), &agent);
        settings
            .set_default_model_and_provider("onboard-test".into(), "m1".into())
            .expect("saved default");
        let options = run_options(dir.path());
        let task = onboarding_task(&options, None).expect("the ready home mounts the flow");
        assert!(
            (task.model_ready)(),
            "the configured default model is ready (the question flow)"
        );

        // Explicit flags that resolve to a provider without configured
        // auth mount the task too (TS `shouldRunOnboarding`: the flag
        // alone), carrying the not-ready branch — the full sign-in flow,
        // not the question. TS `validateConfig` requires an "apiKey" for
        // custom providers, but a `!command` key that fails resolves to
        // nothing (TS `resolveConfigValue`), so the provider stays
        // unauthenticated.
        let mut options = run_options(dir.path());
        options.config.provider = Some("onboard-naked".into());
        options.config.model = Some("m2".into());
        let task = onboarding_task(&options, None).expect("the flag alone mounts the flow");
        assert!(
            !(task.model_ready)(),
            "the naked provider leaves the model not ready (the full flow)"
        );
        assert!(
            task.current_model
                .as_ref()
                .is_some_and(|model| model.id == "m2"),
            "the resolved startup model rides the task (TS getCurrentModel)"
        );
    }

    /// The product sink's persistence over the real settings files: a
    /// provisioned home (sharing explicitly opted out, onboarding never
    /// completed) reads its standing choice through a fresh manager and
    /// the silent completion persists ONLY the flag — the choice stands
    /// untouched, and the next launch's gate reads the flag and never
    /// mounts the task again.
    #[test]
    fn settings_sink_completes_a_provisioned_home_without_touching_the_choice() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        // The provisioned home: sharing opted out, telemetry off (the unit
        // seam stays hermetic — no telemetry client for the completion event).
        let mut provisioned = pa_core::settings::SettingsManager::create(dir.path(), &agent_dir);
        provisioned
            .set_agent_traces_enabled(false)
            .expect("provision the opt-out");
        provisioned
            .set_telemetry_enabled(false)
            .expect("telemetry off");

        let sink = SettingsOnboardingSink {
            cwd: dir.path().to_path_buf(),
            agent_dir: agent_dir.clone(),
            created_at: std::time::Instant::now(),
            probe: StartupModelProbe {
                cwd: dir.path().to_path_buf(),
                agent_dir: agent_dir.clone(),
                cli_provider: None,
                cli_model: None,
                models: None,
                is_continuing: false,
                api_key: None,
            },
        };
        assert!(
            !sink.onboarding_shown(),
            "the never-completed home reads its missing flag through a fresh manager"
        );
        assert!(
            sink.agent_traces_choice_written(),
            "the provisioned opt-out reads through a fresh manager"
        );
        sink.mark_onboarding_complete().expect("silent completion");

        // The next launch reads through its own fresh manager: the gate
        // never mounts the task again and the standing choice survives.
        let settings = pa_core::settings::SettingsManager::create(dir.path(), &agent_dir);
        assert!(settings.get_onboarding_shown(), "the flag persisted");
        assert!(
            !settings.get_agent_traces_enabled(),
            "the standing opt-out survived the silent completion"
        );
    }

    /// A fresh home (no choice written) is the one home the question still
    /// mounts for — the opt-in moment: the flow's `Share` answer persists
    /// beside the completion flag, and both read back through the next
    /// launch's fresh manager.
    #[test]
    fn settings_sink_persists_the_fresh_home_answer_with_the_flag() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let mut provisioned = pa_core::settings::SettingsManager::create(dir.path(), &agent_dir);
        provisioned
            .set_telemetry_enabled(false)
            .expect("telemetry off");

        let sink = SettingsOnboardingSink {
            cwd: dir.path().to_path_buf(),
            agent_dir: agent_dir.clone(),
            created_at: std::time::Instant::now(),
            probe: StartupModelProbe {
                cwd: dir.path().to_path_buf(),
                agent_dir: agent_dir.clone(),
                cli_provider: None,
                cli_model: None,
                models: None,
                is_continuing: false,
                api_key: None,
            },
        };
        assert!(
            !sink.onboarding_shown(),
            "a fresh home has no completion flag yet"
        );
        assert!(
            !sink.agent_traces_choice_written(),
            "a fresh home carries no trace choice (sharing stays off until a choice is made)"
        );
        sink.set_agent_traces_enabled(true).expect("answer Share");
        sink.mark_onboarding_complete()
            .expect("complete onboarding");

        let settings = pa_core::settings::SettingsManager::create(dir.path(), &agent_dir);
        assert!(
            settings.get_onboarding_shown(),
            "the flow marked onboarding shown"
        );
        assert!(
            settings.get_agent_traces_enabled(),
            "the Share answer persisted with the flag"
        );
    }

    #[test]
    fn build_tui_options_reads_code_block_indent_settings() {
        // `markdown.codeBlockIndent` rides InteractiveOptions at startup
        // (TS `getCodeBlockIndent` -> `getMarkdownThemeWithSettings`); a
        // non-default value reaches the TUI, and no setting keeps the TS
        // default two spaces.
        fn run_options(dir: &std::path::Path) -> RunOptions {
            RunOptions {
                app_mode: crate::mode::AppMode::Interactive,
                config: crate::mode::RuntimeConfig {
                    cwd: dir.to_path_buf(),
                    agent_dir: dir.join("agent"),
                    ..Default::default()
                },
                session: Default::default(),
                messages: Vec::new(),
                file_args: Vec::new(),
                daemon_socket: None,
                list_models: None,
                initial_message: None,
                initial_images: Vec::new(),
                verbose: false,
                offline: false,
                agents_view_requested: false,
                attach_agent: None,
            }
        }

        let dir = tempfile::TempDir::new().expect("temp dir");
        let agent = dir.path().join("agent");
        std::fs::create_dir_all(&agent).expect("agent dir");
        std::fs::write(
            agent.join("settings.json"),
            r#"{ "markdown": { "codeBlockIndent": "    " } }"#,
        )
        .expect("settings.json");
        let options = build_tui_options(
            &run_options(dir.path()),
            dir.path().join("d.sock"),
            Default::default(),
        )
        .expect("options");
        assert_eq!(options.code_block_indent, "    ");

        // No markdown settings: the TS default.
        let bare = tempfile::TempDir::new().expect("temp dir");
        std::fs::create_dir_all(bare.path().join("agent")).expect("agent dir");
        let options = build_tui_options(
            &run_options(bare.path()),
            bare.path().join("d.sock"),
            Default::default(),
        )
        .expect("options");
        assert_eq!(options.code_block_indent, "  ");
    }
}
