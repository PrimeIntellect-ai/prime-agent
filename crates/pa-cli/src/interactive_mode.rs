//! Interactive mode wiring: resolve the daemon socket, ensure a supervisor is
//! listening, pick the session from the CLI session flags, and hand off to the
//! pa-tui interactive loop; the session keeps running in the worker after exit.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};

use crate::config;
use crate::mode::RunOptions;
use pa_core::session::discovery::{resolve_session_path, ResolvedSession};
use pa_tui::interactive::{InteractiveOptions, ModelSelection, SessionSelection, UiMode};

mod daemon;

pub use daemon::{ensure_daemon_running, ensure_daemon_running_with};

mod onboarding;

use onboarding::onboarding_task;
#[cfg(test)]
use onboarding::{SettingsOnboardingSink, StartupModelProbe};

mod telemetry;

use telemetry::CliInteractionTelemetry;

#[cfg(test)]
mod tests;

/// Run the interactive TUI attached to the daemon. Returns the exit code.
pub fn run_interactive_mode(options: &RunOptions) -> Result<i32> {
    let socket_path = resolve_socket_path(options.daemon_socket.as_deref());
    let configuration_load_started = std::time::Instant::now();
    let (tui_options, pending_onboarding_stages) = build_tui_options(
        options,
        socket_path,
        std::sync::Arc::new(std::sync::Mutex::new(
            pa_tui::prompt_stash::PromptStashStore::default(),
        )),
    )?;
    let configuration_load_ms = configuration_load_started.elapsed().as_millis() as u64;
    // The telemetry disclosure renders inside the TUI (TS
    // agent-session-services' session diagnostic): the interactive
    // attach pushes the info row once per installation, deferred behind
    // onboarding — a pre-TUI stderr print would be hidden by the alt
    // screen.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("build the interactive runtime")?;
    let startup_started = std::time::Instant::now();
    runtime.block_on(async {
        // The `agent startup stage` telemetry: the configuration-load and
        // session-attach stages measured on the same one-shot client as `startup`.
        let startup_kind: &'static str =
            if options.session.resume.is_some() || options.session.continue_recent {
                "resumed"
            } else {
                "cold"
            };
        let mut startup_telemetry = (!options.config.telemetry_disabled).then(|| {
            let agent_dir = options.config.agent_dir.clone();
            let settings =
                pa_core::settings::SettingsManager::create(&options.config.cwd, &agent_dir);
            pa_core::session_engine::telemetry::build_client(&settings, &agent_dir)
        });
        // The onboarding `entry`/`ready` stages defer to here: an inert client
        // before the runtime exists would drop the events.
        if !pending_onboarding_stages.is_empty() {
            let agent_dir = options.config.agent_dir.clone();
            let settings =
                pa_core::settings::SettingsManager::create(&options.config.cwd, &agent_dir);
            if !crate::mode::telemetry_disabled(&settings) {
                let client =
                    pa_core::session_engine::telemetry::build_client(&settings, &agent_dir);
                for stage in &pending_onboarding_stages {
                    stage.track(&client);
                }
            }
        }
        if let Some(client) = startup_telemetry.as_ref() {
            pa_telemetry::AgentStartupStage {
                stage: "configuration_load",
                outcome: "completed",
                duration_ms: Some(configuration_load_ms),
                startup_kind: Some(startup_kind),
                timing_scope: Some("system_work"),
            }
            .track(client);
        }
        let attach_started = std::time::Instant::now();
        ensure_daemon_running(&tui_options.socket_path, &tui_options.cwd).await?;
        if let Some(client) = startup_telemetry.as_ref() {
            pa_telemetry::AgentStartupStage {
                stage: "session_attach",
                outcome: "completed",
                duration_ms: Some(attach_started.elapsed().as_millis() as u64),
                startup_kind: Some(startup_kind),
                timing_scope: Some("system_work"),
            }
            .track(client);
        }
        // `startup` (schema v1): process entry to a ready interactive
        // session environment (daemon listening). Emitted through a
        // one-shot client; the session's own telemetry rides the daemon
        // worker. The flush handle rides to the end of the run — the
        // quick-exit join below bounds delivery on a fast quit.
        let startup_flush = startup_telemetry.take().map(|client| {
            let daemon_ready_ms = startup_started.elapsed().as_millis() as u64;
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("duration_ms", serde_json::Value::from(daemon_ready_ms));
            let mut phase_timings = pa_telemetry::Properties::new();
            phase_timings.set("daemon_ready", serde_json::Value::from(daemon_ready_ms));
            properties.set_map("phase_timings", &phase_timings);
            client.track("startup", properties);
            pa_telemetry::AgentStartupStage {
                stage: "ui_ready",
                outcome: "completed",
                duration_ms: Some(daemon_ready_ms),
                startup_kind: Some(startup_kind),
                timing_scope: Some("system_work"),
            }
            .track(&client);
            flush_startup_telemetry(client)
        });
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
        let agents_view = should_open_agents_view(
            options,
            tui_options.onboarding.is_some(),
            continue_view.is_some(),
        );
        // The interactive dispatch, one future so EVERY exit — the view
        // loop's, the session run's, a failed open's error return —
        // passes the quick-exit join below.
        let run = async {
            if agents_view {
                let (anchor, notice) = continue_view.map_or((None, None), |view| {
                    (Some(view.session_id), Some(view.notice))
                });
                run_agents_view_flow(tui_options, anchor, notice).await
            } else {
                let outcome =
                    pa_tui::interactive::run_interactive(tui_options.clone(), UiMode::Terminal)
                        .await?;
                // TS `main.ts`: a direct session run closes into the agents view
                // when the exit came through agents-back or `/resume`
                // (`launchAgentsView` anchored on the session just left); every
                // other exit (ctrl+c/ctrl+d, `/quit`) ends the process.
                if outcome.return_to_agents_view {
                    // A startup attach that fell back to the view has no session
                    // identity to anchor on; its notice seeds the view's status
                    // line instead.
                    let anchor =
                        (!outcome.session_id.is_empty()).then(|| outcome.session_id.clone());
                    run_agents_view_flow(tui_options, anchor, outcome.agents_view_notice).await
                } else {
                    print_resume_hint(outcome.resume_hint.as_deref());
                    Ok(())
                }
            }
        };
        let result = run.await;
        // The quick-exit join: the runtime that owns the handed-off drain
        // dies with this block, so a run that ends inside the delivery
        // window (a fast quit — the sink allows up to 1.5s) would lose
        // the startup events to the teardown. The same shared exit bound
        // `tui exit` and the agents-view exit report already join under
        // applies here: the drain delivers (typical ~150ms) or drops,
        // bounded — never cut mid-POST.
        if let Some(flush) = startup_flush {
            let _ = tokio::time::timeout(
                Duration::from_millis(pa_tui::interactive::TELEMETRY_EXIT_TIMEOUT_MS),
                flush,
            )
            .await;
        }
        result
    })?;
    // tmux (verified on 3.2a) can drop the pane's final output when the process
    // dies immediately after writing it; holding briefly lets the terminal apply it.
    std::thread::sleep(Duration::from_millis(300));
    Ok(0)
}

/// The one-shot startup client's final flush, handed to the runtime:
/// fire-and-forget from the paint path's perspective — the tracked
/// `startup` events' delivery belongs to the background worker (the
/// sink's bounded request timeout; a re-sent batch keeps its event ids,
/// so the backend dedupes), never to the first frame. The returned
/// handle is the quick-exit seam: the composition root joins it under
/// the shared exit bound when the run ends inside the delivery window,
/// so a fast quit delivers (or drops, bounded) instead of the runtime
/// teardown cutting the worker mid-POST.
/// `the_startup_flush_never_blocks_the_first_frame` guards the boundary
/// with a hanging sink: the flush hand-off must complete while delivery
/// is still blocked.
pub(super) fn flush_startup_telemetry(
    client: pa_telemetry::TelemetryClient,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let _ = client.shutdown().await;
    })
}

/// TS `shutdown` prints the dim resume hint (`formatResumeHint`) to stdout
/// after the TUI is restored; agents-view returns suppress it. Dim is the
/// TS `chalk.dim` styling (`ESC[2m` ... `ESC[22m`). The print is the last
/// exit-path write before the fixed pre-exit delay below, and on a slow
/// terminal it blocks behind the flush still draining the pty: its
/// completion is exit-path progress (the exit guard's watchdog holds its
/// force-quit while progress lands — a draining terminal is not a stalled
/// shutdown), and the stamp it leaves carries the fixed delay inside the
/// guard's grace window.
fn print_resume_hint(hint: Option<&str>) {
    if let Some(hint) = hint {
        println!("\x1b[2m{hint}\x1b[22m");
    }
    pa_tui::exit_guard::note_exit_progress();
}

/// The agents-view loop: open the view, run the session it opens, and return
/// to the view on agents-back or bare `/resume`; every other exit ends the app.
async fn run_agents_view_flow(
    base: InteractiveOptions,
    anchor: Option<String>,
    notice: Option<String>,
) -> Result<()> {
    let mut anchor = anchor;
    // Every view run reuses the roster connection (a chat run hands it
    // back), so a switch back from a chat skips the handshake.
    let mut roster_link: Option<pa_tui::agents_view::AgentsViewLink> = None;
    let mut frames: Vec<(
        pa_tui::agents_view::AgentsViewScope,
        Option<SessionSelection>,
    )> = Vec::new();
    let mut query: Option<String> = None;
    // A dismissal survives the next view run.
    let mut incident_notice_state: Option<pa_tui::incident_notices::IncidentNoticeState> = None;
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
            keybindings: base.keybindings.clone(),
            show_hardware_cursor: base
                .client_settings
                .as_ref()
                .is_some_and(|settings| settings.show_hardware_cursor()),
            incident_notice_state: incident_notice_state.take(),
            // The base a saved reply's resume derives from.
            create_config: base.create_config(),
        };
        let view_run = pa_tui::agents_view::run_agents_view(
            view_options,
            pa_tui::agents_view::AgentsViewUiMode::Terminal,
            roster_link.take(),
        )
        .await?;
        let mut view = view_run.outcome;
        let actions_report = {
            let telemetry = base.telemetry.clone();
            let actions = std::mem::take(&mut view.actions);
            async move {
                for action in actions {
                    if let Some(telemetry) = telemetry.as_ref() {
                        telemetry.agents_view_action(action).await;
                    }
                }
            }
        };
        roster_link = view_run.link;
        // A dropped scope root or the view's parent key pops the frame;
        // both clear the query.
        let scope_frame_popped = view.scope_dropped || view.scope_popped;
        if scope_frame_popped {
            frames.pop();
        }
        let Some(selection) = view.selection else {
            let _ = tokio::time::timeout(
                Duration::from_millis(pa_tui::interactive::TELEMETRY_EXIT_TIMEOUT_MS),
                actions_report,
            )
            .await;
            return Ok(());
        };
        tokio::spawn(actions_report);
        expanded_ancestors = view.expanded_ancestors.clone();
        selected_row_identity = view.selected_row_identity.clone();
        selected_key = view.selected_key.clone();
        status_message = view.status_message.clone();
        incident_notice_state = Some(view.incident_notice_state);
        query = if scope_frame_popped { None } else { view.query };
        let mut session_options = base.clone();
        session_options.session = selection;
        session_options.session_rlm_depth = view.opened_rlm_depth;
        session_options.session_has_children = view.opened_has_children;
        // A scoped panel's own exit reopens the chat with the dock focused
        // on the Subagents item, not the prompt bar.
        session_options.restore_dock_focus = view.scope_back;
        // The session run anchors its cwd (and the file-completion base)
        // on the attached session's directory, not the launch directory.
        if let Some(cwd) = view.opened_cwd {
            session_options.cwd = cwd;
        }
        let outcome = pa_tui::interactive::run_interactive_agents_view_open(
            session_options,
            UiMode::Terminal,
        )
        .await?;
        if !outcome.session_id.is_empty() {
            anchor = Some(outcome.session_id.clone());
        }
        if let Some(notice) = &outcome.agents_view_notice {
            status_message = Some(notice.clone());
        }
        if !outcome.return_to_agents_view {
            print_resume_hint(outcome.resume_hint.as_deref());
            if let Some(link) = roster_link.take() {
                link.close();
            }
            return Ok(());
        }
        if let Some(scope) = outcome.agents_view_scope {
            // Push a frame with the session as the return chat and clear the
            // query — a filter typed to find the session would hide the subtree.
            frames.retain(|(frame, _)| frame.session_id != scope.session_id);
            frames.push((
                scope,
                Some(SessionSelection::Attach(outcome.active_session_id.clone())),
            ));
            query = None;
        }
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
                print_resume_hint(outcome.resume_hint.as_deref());
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
#[must_use]
pub fn resolve_socket_path(daemon_socket: Option<&str>) -> PathBuf {
    config::resolve_daemon_socket_path(daemon_socket)
}

fn build_tui_options(
    options: &RunOptions,
    socket_path: PathBuf,
    prompt_stash: std::sync::Arc<std::sync::Mutex<pa_tui::prompt_stash::PromptStashStore>>,
) -> Result<(InteractiveOptions, Vec<pa_telemetry::OnboardingStage>)> {
    let config = &options.config;
    let session_dir = options
        .session
        .session_dir
        .clone()
        .or_else(|| Some(config.agent_dir.join("sessions")));
    if let Err(error) = pa_tui::keybindings::migrate_keybindings_file(&config.agent_dir) {
        // A failed migration never blocks startup: the manager below
        // falls back to the previous file contents (or the defaults).
        eprintln!("Warning: could not migrate keybindings: {error:#}");
    }
    let keybindings = pa_tui::keybindings::KeybindingsManager::create(&config.agent_dir);
    // Test seam: a scripted faux daemon session; never set by the product.
    let script_path = std::env::var_os("PRIME_AGENT_FAUX_SCRIPT").map(PathBuf::from);
    // Flag order (fork -> resume -> create): the daemon opens the fork —
    // never the source — through the create `sessionPath`.
    let session = match &options.session.fork {
        Some(selector) => fork_startup_selection(selector, &config.cwd, session_dir.as_deref())?,
        None => session_selection(&options.session, session_dir.as_deref()),
    };
    let settings = pa_core::settings::SettingsManager::create(&config.cwd, &config.agent_dir);
    let code_block_indent = settings.get_code_block_indent();
    let show_images = settings.get_show_images();
    let fullscreen_mouse = settings.get_fullscreen_mouse();
    let tree_filter_mode = settings.get_tree_filter_mode();
    let branch_summary_skip_prompt = settings.get_branch_summary_skip_prompt();
    // A startup snapshot of the available models drives the `/model` picker
    // (entitlement refreshes run daemon-side); models.json custom models too.
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
    let provider_auth = pa_tui::provider_auth::ProviderAuthCommandsHandle(std::sync::Arc::new(
        crate::provider_login::ProviderAuth::new(config.cwd.clone(), config.agent_dir.clone()),
    ));
    let (onboarding, pending_onboarding_stages) =
        onboarding_task(options, Some(provider_auth.clone()));
    let tui_options_value = InteractiveOptions {
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
        // Explicit CLI model flags ride every create request; the daemon
        // worker must treat them as authoritative.
        model_selection: ModelSelection {
            provider: config.provider.clone(),
            model: config.model.clone(),
            api_key: config.api_key.clone(),
            // The worker clamps `--thinking` to the model's levels.
            thinking: config.thinking,
        },
        // The raw `--models` patterns ride the create config (the daemon
        // owns the resolution).
        models: config.models.clone(),
        no_session: options.session.no_session,
        session,
        initial_message: options.initial_message.clone(),
        show_images,
        fullscreen_mouse,
        theme: settings.get_theme().map(str::to_string).unwrap_or_default(),
        // The client-settings seam the interactive commands persist
        // through (`/settings`).
        client_settings: Some(crate::client_settings::CliClientSettings::new(
            config.cwd.clone(),
            config.agent_dir.clone(),
        )),
        version: crate::config::version().to_string(),
        onboarding,
        telemetry_disabled: crate::mode::create_telemetry_disabled(config),
        // `/mcp login` / `/mcp logout`: the client-side auth flows run in
        // this process (the TS interactive client's placement) and persist
        // through the shared auth store the daemon's sessions read.
        client_auth: Some(pa_tui::client_auth::ClientAuthCommandsHandle(
            std::sync::Arc::new(crate::mcp_login::TerminalMcpAuth::new(
                config.cwd.clone(),
                config.agent_dir.clone(),
            )),
        )),
        traces: Some(pa_tui::traces::TracesCommandsHandle(std::sync::Arc::new(
            crate::client_traces::ClientTraces::new(config.cwd.clone(), config.agent_dir.clone()),
        ))),
        // `/update`: the same body `prime-agent update` runs, output
        // captured — the TUI stays mounted.
        update_commands: Some(pa_tui::update_command::UpdateCommandsHandle(
            std::sync::Arc::new(crate::client_update::ClientUpdate),
        )),
        provider_auth: Some(provider_auth),
        telemetry: Some(std::sync::Arc::new(CliInteractionTelemetry::new(
            config.cwd.clone(),
            config.agent_dir.clone(),
        ))),
        keybindings,
        // One process-wide prompt stash store, so the agents-view loop
        // keeps stashed drafts alive across its chat runs.
        prompt_stash,
        // A direct CLI session is a root run (RLM depth metadata comes
        // from the agents view).
        session_rlm_depth: None,
        session_has_children: false,
        restore_dock_focus: false,
    };
    Ok((tui_options_value, pending_onboarding_stages))
}

/// Map the CLI session flags onto the TUI session selection: explicit `--resume`
/// selector, then a fresh session (`--continue` goes through the agents view).
fn session_selection(
    session: &crate::mode::SessionOptions,
    session_dir: Option<&Path>,
) -> SessionSelection {
    if let Some(selector) = &session.resume {
        let default_dir = config::get_agent_dir().join("sessions");
        let dir = session_dir.unwrap_or(&default_dir);
        return resolve_resume_selector(selector, dir);
    }
    SessionSelection::New
}

/// The interactive launch's fork arm: copy the source into a fresh session file
/// client-side ([`pa_core::session::manager::SessionManager::fork_from`]) and
/// hand the daemon the fork — never the source.
///
/// # Errors
///
/// A selector that matches nothing, or the `forkFrom` failures (an empty or
/// headerless source file).
fn fork_startup_selection(
    selector: &str,
    cwd: &Path,
    session_dir: Option<&Path>,
) -> Result<SessionSelection> {
    let default_dir = config::get_agent_dir().join("sessions");
    let dir = session_dir.unwrap_or(&default_dir);
    let expanded = config::expand_tilde_path(selector);
    let selector = expanded.to_string_lossy();
    let resolved = resolve_session_path(&selector, cwd, dir)
        .map_err(|error| anyhow!(crate::print_runtime::render_selector_error(&error)))?;
    let source = match resolved {
        ResolvedSession::Path(path)
        | ResolvedSession::Local(path)
        | ResolvedSession::Global { path, .. } => path,
    };
    let forked = pa_core::session::manager::SessionManager::fork_from(&source, cwd, dir)
        .map_err(anyhow::Error::msg)?;
    let fork_file = forked
        .get_session_file()
        .map(Path::to_path_buf)
        .ok_or_else(|| {
            anyhow!(
                "Cannot fork: the forked session file is missing: {}",
                source.display()
            )
        })?;
    Ok(SessionSelection::Resume(fork_file))
}

/// A selector, continuation, or fork opens its target session directly; only the
/// explicit `agents` request needs the onboarding guard.
fn should_open_agents_view(
    options: &RunOptions,
    onboarding_pending: bool,
    continue_view: bool,
) -> bool {
    options.session.resume_bare
        || (options.agents_view_requested && !onboarding_pending && options.session.fork.is_none())
        || continue_view
}

/// The `--continue` launch's agents-view target: the newest saved session
/// for the cwd, plus the status-line notice that names it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ContinueRecentView {
    session_id: String,
    notice: String,
}

/// Resolve the `--continue` launch into an agents-view opening: never a blind
/// newest-resume (a sanctioned divergence — TS reopens the candidate silently).
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
