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
use pa_core::session::discovery::{resolve_session_path, ResolvedSession};
use pa_tui::interactive::{InteractiveOptions, ModelSelection, SessionSelection, UiMode};

const DAEMON_STARTUP_TIMEOUT_MS: u64 = 30_000;
const DAEMON_SHUTDOWN_WAIT_MS: u64 = 5_000;
/// Pause between daemon-startup probes (TS `ensureDaemonRunning` polls at
/// 25ms). This port tightens the poll to 5ms: a cold supervisor binds its
/// socket ~39ms after the spawn and the 25ms grid quantized every cold
/// launch by 0-25ms (mean ~12.5ms) of pure wait (boot-floor lane record
/// 20260926-194800 at 7064d039a). Timing-only: the probe itself, the
/// 30s startup budget, and the timeout error are unchanged.
const DAEMON_PROBE_INTERVAL_MS: u64 = 5;

// The first-run onboarding concern (the startup-model probe, the
// settings sink over the pa-tui trait, and the startup task assembly)
// moved to the child module at the same tree position
// (interactive_mode::onboarding); the task binding keeps the startup
// assembly's bare call in scope, and the cfg(test) bindings keep the
// unit battery's struct literals in scope.
mod onboarding;

use onboarding::onboarding_task;
#[cfg(test)]
use onboarding::{SettingsOnboardingSink, StartupModelProbe};

// The interaction-telemetry concern (the one-shot client wrapper and
// the adoption events the pa-tui interactive loop reports through the
// InteractionTelemetry trait) moved to the child module at the same
// tree position (interactive_mode::telemetry); the binding keeps the
// startup assembly's bare construction in scope.
mod telemetry;

use telemetry::CliInteractionTelemetry;

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
        let agents_view = should_open_agents_view(
            options,
            tui_options.onboarding.is_some(),
            continue_view.is_some(),
        );
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
/// TS `chalk.dim` styling (`ESC[2m` ... `ESC[22m`). The print is the last
/// exit-path write before the fixed pre-exit delay below, and on a slow
/// terminal it blocks behind the flush still draining the pty: its
/// completion is exit-path progress (the exit guard's watchdog holds its
/// force-quit while progress lands — a draining terminal is not a stalled
/// shutdown), and the stamp it leaves carries the fixed delay inside the
/// guard's grace window.
fn print_resume_hint(hint: &Option<String>) {
    if let Some(hint) = hint {
        println!("\x1b[2m{hint}\x1b[22m");
    }
    pa_tui::exit_guard::note_exit_progress();
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
    // The view/session loop's carried incident notice state (TS
    // `persistentState.incidentNoticeState`): a dismissal survives the
    // next view run, and the 30s poll continues from the consumed offset.
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
            // TS `persistentState.incidentNoticeState`: the incident
            // notice state survives leaving and re-entering the view (a
            // dismissed incident never comes back, and the poll does not
            // re-read consumed bytes).
            incident_notice_state: incident_notice_state.take(),
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
        incident_notice_state = Some(view.incident_notice_state);
        query = if scope_frame_popped { None } else { view.query };
        // The opened row's depth metadata rides the session run (TS
        // `sessionDepth`/`sessionHasChildren`): a drilled-in child renders
        // its `depth N` tray label.
        let mut session_options = base.clone();
        session_options.session = selection;
        session_options.session_rlm_depth = view.opened_rlm_depth;
        session_options.session_has_children = view.opened_has_children;
        // The scoped panel's own exit (the parent key or escape) reopened
        // the scope root's chat: it starts with the dock focused on the
        // panel's own group (the Subagents item), not the prompt bar —
        // a plain row open keeps the editor's focus.
        session_options.restore_dock_focus = view.scope_back;
        // The opened session's own directory rides the options: the
        // session run anchors its cwd (and the file-completion base) on
        // the attached session's directory, not the launch directory the
        // view opened from (TS `getCurrentCwd`).
        if let Some(cwd) = view.opened_cwd {
            session_options.cwd = cwd;
        }
        // The agents-view open route (TS `runAgentsViewLoop` ->
        // `openAgentsViewSession`, TS #2391): the open waits through a
        // daemon update restart instead of failing hard.
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
    // TS `createSessionManager`'s flag order (fork -> resume -> create):
    // a fork copies its source into a fresh file client-side, and the
    // daemon opens the fork — never the source — through the create
    // `sessionPath` (TS `getInteractiveDaemonSessionPath`).
    let session = match &options.session.fork {
        Some(selector) => fork_startup_selection(selector, &config.cwd, session_dir.as_deref())?,
        None => session_selection(&options.session, &session_dir)?,
    };
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
        // `/update`: the out-of-band installer funnel (the same body
        // `prime-agent update` runs, with the output captured — the TUI
        // stays mounted and the outcome lands as rows).
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
        // a root run. A direct launch never reopens from the scoped panel,
        // so the dock's focus restore stays off (the editor owns it).
        session_rlm_depth: None,
        session_has_children: false,
        restore_dock_focus: false,
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

/// TS `createSessionManager`'s fork arm for the interactive launch: resolve
/// the selector, copy the source into a fresh session file client-side
/// ([`pa_core::session::manager::SessionManager::fork_from`], the same
/// copy print mode uses), and hand the daemon the fork — never the source —
/// as the create `sessionPath` (TS `getInteractiveDaemonSessionPath`). Every
/// resolution shape forks: a GLOBAL session is exactly what `--fork` is for
/// (a different project's session copied into this cwd). No daemon-active
/// guard applies: the copy reads the source and writes a brand-new file, so
/// a session a live worker already hosts forks fine (TS parity).
///
/// # Errors
///
/// Returns the TS startup failures: a selector that matches nothing (with
/// the browse hint), and the `forkFrom` contract failures (an empty or
/// headerless source file). A leading `~` in the selector expands against
/// the home dir ([`crate::config::expand_tilde_path`]), the resume
/// selector's convention.
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
        .map_err(|error| anyhow!(crate::print_runtime::render_selector_error(error)))?;
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

/// TS `shouldOpenAgentsViewForDaemonInteractive`: a selector, continuation,
/// or fork opens its target session directly instead of the agents view.
/// The selector (`--resume <id>`) and `--continue` launches never reach the
/// view with `--fork` anyway (the shared flag validation refuses the
/// combination at startup), so only the explicit `agents` request needs the
/// guard; bare `--resume` still opens the view, as does a `--continue` with
/// a saved candidate.
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
///
/// # Errors
/// Returns an error when this process's executable path cannot be
/// resolved, when a stale daemon has active work and refuses replacement,
/// when the supervisor process cannot be spawned, or when no current
/// daemon starts before the startup timeout.
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
///
/// # Errors
/// Returns an error when the supervisor process cannot be spawned or when
/// no current daemon starts before the startup timeout.
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
        tokio::time::sleep(Duration::from_millis(DAEMON_PROBE_INTERVAL_MS)).await;
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
            rest: serde_json::Map::default(),
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
                rest: serde_json::Map::default(),
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

// The inline unit battery moved to the child module at the same tree
// position (interactive_mode::tests); its use-super glob keeps resolving
// through the facade's bindings and the pub contract.
#[cfg(test)]
mod tests;
