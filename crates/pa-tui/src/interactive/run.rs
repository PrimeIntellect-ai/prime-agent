//! The run concern (moved with its concern): the interactive run's entry
//! points and open routes, the terminal/headless surface loop with the
//! reconnect and settle gates, and the loop's timing constants.

use super::{
    apply_startup_chrome, arm_shutdown_recovery, check_tmux_keyboard_setup, mpsc,
    run_onboarding_phase, spawn_session_reader, AgentView, DaemonClient, Duration, ExitGuard,
    HeadlessSettle, Instant, InteractiveOptions, InteractiveOutcome, PaneDrive, ReconnectConnect,
    ReconnectLoop, RecoveryKind, Renderer, Result, SessionReconnect, SessionSelection, SessionUi,
    TerminalHandoff, UiInput, UiMode, VecDeque, SESSION_RECONNECT_ATTEMPT_TIMEOUT_S,
    TELEMETRY_EXIT_TIMEOUT_MS,
};
use crate::suspend::SuspendTerminal;
use anyhow::Context;

/// The headless exit gate's settle bound: after the plan completes
/// ([`UiInput::HeadlessDone`]), the run must end within this much wall
/// clock. The gate has no other bound — a settle member that never drains
/// (the `interactive_daemon_e2e` exit-gate wedge family: a submit/switch
/// round-trip race latching `turn_active` with the whole daemon trio
/// idle) parks the run in `Runtime::block_on` forever and eats a whole
/// CI job budget with no failure name. The bound converts that into an
/// attributable error naming the stuck member(s). Terminal runs never
/// arm it: `HeadlessDone` exists only on the headless harness, and the
/// gate is unreachable there (a live terminal ends the run on
/// `exit_requested`). The margin: green settles are milliseconds (the
/// suite's 32-test green wall is ~15s; the last submit's own ack bound
/// is 10s), so 60s is a settle that went wrong, never a slow green.
const HEADLESS_SETTLE_TIMEOUT_MS: u64 = 60_000;

/// TS `TUI.MIN_RENDER_INTERVAL_MS`: the frame scheduler's minimum spacing
/// between renders (every state change in the window coalesces into the
/// next frame, capping the render rate at ~60fps however fast the stream
/// delivers).
const MIN_RENDER_INTERVAL: Duration = Duration::from_millis(16);
/// The spinner's wall-clock cadence (TS `Loader` `DEFAULT_INTERVAL_MS`):
/// the animation phase advances one frame per 80ms of animating time
/// regardless of the render rate.
const SPINNER_INTERVAL_MS: u128 = 80;

/// Run the interactive UI until the user exits (terminal) or the plan
/// completes (headless).
///
/// Every error return funnels through the one exit restore: an early `?`
/// between the surface mount and the deliberate tail teardown (a draw
/// failure, a key-handler transport error, a suspend/resume failure)
/// must not hand the shell a terminal still in TUI state — raw mode,
/// the alternate screen, the enhancement modes armed. The restore is
/// idempotent, so a return after the tail already ran (the startup
/// refusal path finishes the surface itself) only re-emits the two
/// unconditional tail bytes.
/// The open route for one interactive run (TS `runAgentsViewLoop`'s
/// open versus the CLI's own open): the agents-view open waits through a
/// daemon update restart (TS #2391) instead of failing the open hard.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SessionOpenRoute {
    /// The CLI's open (`prime-agent`, `--resume`, `--attach`): a single
    /// attempt, today's behavior — a preparing-restart create refusal
    /// hands off to the agents view with the refusal as its status line.
    Cli,
    /// The agents view's open (TS `runAgentsViewLoop` ->
    /// `openAgentsViewSession`): the open waits through the
    /// update-restart window and retries against the successor.
    AgentsView,
}

/// Run one interactive session (the CLI open route).
///
/// # Errors
///
/// Returns `Err` when the interactive surface fails (the daemon
/// connection, a transport error in a key handler, a draw failure, a
/// suspend/resume failure); the restore runs first whenever this run
/// owned or adopted the terminal.
pub async fn run_interactive(
    options: InteractiveOptions,
    ui: UiMode,
) -> Result<InteractiveOutcome> {
    run_interactive_route(options, ui, SessionOpenRoute::Cli).await
}

/// Run one interactive session opened from the agents view (TS #2391): the
/// startup open waits through a daemon update restart instead of failing
/// (see [`SessionOpenRoute::AgentsView`]).
///
/// # Errors
///
/// Returns `Err` when the interactive surface fails (the daemon
/// connection, a transport error in a key handler, a draw failure, a
/// suspend/resume failure) or the open waits out the update-restart
/// window; the restore runs first whenever this run owned or adopted
/// the terminal.
pub async fn run_interactive_agents_view_open(
    options: InteractiveOptions,
    ui: UiMode,
) -> Result<InteractiveOutcome> {
    run_interactive_route(options, ui, SessionOpenRoute::AgentsView).await
}

async fn run_interactive_route(
    options: InteractiveOptions,
    ui: UiMode,
    route: SessionOpenRoute,
) -> Result<InteractiveOutcome> {
    // The headless harness drives the same dispatch on plain pipes: it
    // never owned the terminal, so its error returns must not run a
    // restore (the mode gates it — the distinction the headless e2e
    // binaries observe, not `restore_terminal`'s pipe no-op).
    let owns_terminal = matches!(ui, UiMode::Terminal);
    // A terminal-mode error that fired BEFORE this surface mounted (the
    // daemon connection refused at the top) must not tear down whatever
    // the CALLER had up: the restore runs only once this run's surface
    // actually mounted.
    let surface_mounted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mounted = std::sync::Arc::clone(&surface_mounted);
    match run_interactive_surface(options, ui, route, mounted).await {
        Ok(outcome) => Ok(outcome),
        Err(error) => {
            // Restore when THIS run changed the terminal state (the flag
            // arms at the raw-mode entry inside `Renderer::setup`) OR
            // when it entered on a pane already in TUI state (the
            // agents-view preserve handoff: the adopting surface owns the
            // release even when it fails before mounting — the process is
            // exiting and no other writer remains). A fresh-pane
            // pre-mount failure (the daemon refused the connect) has
            // nothing to release and must not tear down the caller.
            if owns_terminal
                && (surface_mounted.load(std::sync::atomic::Ordering::SeqCst)
                    || crate::altscreen::active())
            {
                crate::exit_restore::restore_terminal();
            }
            Err(error)
        }
    }
}

async fn run_interactive_surface(
    options: InteractiveOptions,
    ui: UiMode,
    route: SessionOpenRoute,
    surface_mounted: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<InteractiveOutcome> {
    // The TS theme emits raw ANSI color codes regardless of NO_COLOR; match
    // that so the same terminal renders the same frames either way.
    crossterm::style::force_color_output(true);
    // The startup open's connection: the first open attempt below uses
    // this one (a fresh-pane connect failure must stay a pre-mount
    // failure, so the CLI open keeps its no-restore teardown), while a
    // wait retry reconnects against the successor daemon.
    let (client, events) = DaemonClient::connect_with_retry(&options.socket_path)
        .await
        .with_context(|| "the interactive UI could not attach to the daemon")?;
    // Background notes (a failed abort request) fold into the transcript
    // through the same loop that renders daemon events.
    let (notes_tx, mut notes_rx) = mpsc::unbounded_channel::<String>();
    // The backgrounded compaction abort reports here; the loop folds a
    // failed abort into the transcript note and clears the stuck loader.
    let (compaction_abort_tx, mut compaction_abort_rx) =
        mpsc::unbounded_channel::<crate::session_ui::CompactionAbortNote>();
    // A backgrounded prompt round trip reports here (TS `onSubmit`
    // resolves `agentConnection.prompt` off the render path — the
    // cleared editor paints before the daemon answers); the loop folds
    // the settled outcome into the session.
    let (prompt_tx, mut prompt_rx) =
        mpsc::unbounded_channel::<crate::session_ui::PromptSubmitNote>();
    // The `/share` upload task reports here; the loop folds the outcome
    // into the transcript and clears the loader.
    let (share_tx, mut share_rx) = mpsc::unbounded_channel::<crate::session_ui::ShareNote>();
    // The background `/update` run (the installer funnel) reports here;
    // the loop folds the outcome into the success note or the error row.
    let (update_tx, mut update_rx) = mpsc::unbounded_channel::<crate::session_ui::UpdateNote>();
    // The `/reload` task reports here; the loop folds the client-side
    // re-reads (keybindings, theme) and the outcome row.
    let (reload_tx, mut reload_rx) = mpsc::unbounded_channel::<crate::session_ui::ReloadNote>();
    // The `/traces upload-all` sweep reports here; the loop folds the live
    // progress into the status row and the settled summary.
    let (traces_upload_tx, mut traces_upload_rx) =
        mpsc::unbounded_channel::<crate::session_ui::TracesUploadNote>();
    // The background model-catalog refresh (`get_model_catalog`) reports
    // here; the loop folds it into the picker catalog and any open picker.
    let (catalog_tx, mut catalog_rx) =
        mpsc::unbounded_channel::<crate::session_ui::ModelCatalogUpdate>();
    // Background heartbeat-catalog refreshes (`heartbeats_list` for an
    // open `/heartbeats` view) report here; the loop folds them into the
    // open view.
    let (heartbeats_tx, mut heartbeats_rx) =
        mpsc::unbounded_channel::<crate::session_ui::HeartbeatsUpdate>();
    // The inline auth panel's login flows drive the panel through this
    // channel (progress lines, the URL block, prompts, the team picker,
    // and each flow's settled outcome); the loop owns the receiving side
    // and folds every request into the mounted panel.
    let (auth_panel_tx, mut auth_panel_rx) =
        mpsc::unbounded_channel::<crate::auth_panel::AuthPanelRequest>();
    let (bash_tx, mut bash_rx) = mpsc::unbounded_channel::<crate::session_ui::BashActivityUpdate>();
    // Background slash-command-catalog refreshes (`get_commands`) report
    // here; the loop folds the session's skill commands into the
    // autocomplete provider.
    let (commands_tx, mut commands_rx) =
        mpsc::unbounded_channel::<crate::session_ui::CommandCatalogUpdate>();
    // The double-Ctrl+C force-quit guard: the terminal reader observes the
    // pair even while this loop is wedged in a daemon request, and a plain
    // std-thread watchdog enforces the exit deadline without the runtime.
    let exit_guard = ExitGuard::new();

    // The view and the terminal surface come up BEFORE the session attach
    // (TS `init`: `ui.start()` paints the header + editor first, then
    // `rebindCurrentSession` loads the session; the header's model and cwd
    // lines fill in when the connection state loads). The pane paints the
    // startup chrome immediately instead of holding the previous surface
    // (or a blank pane) until the attach snapshot arrives; the transcript
    // itself renders when the snapshot lands — `rebuild_view`'s dirty flag
    // schedules the first full repaint, so no resize event is ever needed
    // to see the attached session.
    let theme = crate::app::load_theme(&options.theme);
    let mut view = AgentView::new(theme);
    view.code_block_indent = options.code_block_indent.clone();
    // The file-completion provider browses the SESSION cwd (TS
    // `createBaseAutocompleteProvider` anchors on `this.getCurrentCwd()`),
    // not the process cwd: the editor constructor's `env::current_dir()`
    // default only matches when the launch directory is the session cwd —
    // the attach flows pass the session's own cwd, and the completion
    // menu must browse the directory the user sees.
    view.editor.set_autocomplete_provider(Box::new(
        crate::autocomplete::CombinedAutocompleteProvider::from_registry(options.cwd.clone()),
    ));
    // The effective bindings (user `keybindings.json` merged over the TS
    // defaults) drive the editor, the pickers, and every hint the view
    // renders (TS `KeybindingsManager.create()` + `setKeybindings`).
    view.editor.set_keybindings(options.keybindings.clone());
    // The `terminal.showImages` setting rides the startup options (TS
    // `getShowImages`), resolved by the composition root.
    view.show_images = options.show_images;
    if let Some(settings) = &options.client_settings {
        // TS constructs the chat TUI with the live `showHardwareCursor`
        // value (interactive-mode.ts `new TUI(..., getShowHardwareCursor())`);
        // the settings menu's toggle updates it in place.
        view.show_hardware_cursor = settings.show_hardware_cursor();
        // TS #2709: the interactive-mode constructor assigns the persisted
        // `chatDetail` level (`assignChatDetail(getChatDetail())`), so a
        // chat opens at the level the last Ctrl+O pick saved - and an
        // unset store reads as the collapsed `overview` startup level
        // (the collapse mode: every activity item renders as `details`
        // does, only the thinking hidden; operator directive
        // 2026-09-28).
        view.detail = crate::chat::Detail::from_wire_name(&settings.chat_detail());
    }
    apply_startup_chrome(&mut view, &options);
    let (ui_tx, mut ui_rx) = mpsc::unbounded_channel::<UiInput>();
    // Headless verification runs capture the OSC 52 clipboard channel
    // instead of writing it to the plain pipes.
    let headless = matches!(ui, UiMode::Headless(_));
    // A panic anywhere between the mount below and the deliberate
    // teardown must still hand the terminal back whole: the unwind guard
    // fires the one exit restore while the frame is dying (a set_hook
    // cannot carry this — tokio catches task panics and the process
    // would live on with a half-restored surface).
    let _surface_restore = crate::exit_restore::SurfaceRestore::armed();
    let mut renderer = Renderer::setup(
        ui,
        ui_tx,
        exit_guard.clone(),
        options.fullscreen_mouse,
        &surface_mounted,
    )?;
    // The startup chrome paints before the session loads only for a NEW
    // chat (TS `ui.start()` renders the banner once before the session
    // loads): the startup chrome carries the zero dock a fresh session
    // mounts (`apply_startup_chrome`), so the placeholder frame never
    // reflows when the attach lands. A direct open into an existing
    // session holds the previous surface instead (TS attaches BEFORE
    // the chat mounts — main.ts and the agents view construct the chat
    // over an already-attached connection whose `getInitialSnapshot`
    // is cached, so the first visible frame is the content): the queued
    // clear rides the first draw's single flush, which carries the
    // complete frame — no splash flash, no panel appearing late over a
    // half-open view.
    if !headless && matches!(&options.session, SessionSelection::New) {
        if let Some(renderer) = renderer.is_terminal_mut() {
            crate::app::draw(renderer, &mut view)?;
        }
    }
    // The startup open (TS `runAgentsViewLoop` -> `openAgentsViewSession`,
    // TS #2391): an agents-view open that lands while the daemon prepares an
    // update restart waits through the restart window (bounded, 500ms retry
    // cadence, the attached-session reconnect budget) and retries against
    // the successor instead of failing the open; the CLI route keeps the
    // single attempt. The first attempt reuses the pre-mount connection; a
    // retry reconnects fresh. Only the open waits — once the session is up,
    // the reconnect loop owns the mid-chat restart window.
    let mut first_connection = Some((client, events));
    let open_outcome = crate::update_restart_wait::wait_through_update_restart(
        route == SessionOpenRoute::AgentsView,
        crate::update_restart_wait::DAEMON_UPDATE_RESTART_OPEN_WAIT_MS,
        crate::update_restart_wait::DAEMON_UPDATE_RESTART_OPEN_RETRY_MS,
        || {
            // The attempt future owns everything it touches (an `async
            // move` over clones taken here): an `FnMut` closure's captures
            // may not escape into the returned future, so the synchronous
            // body moves the pieces out instead.
            let first = first_connection.take();
            let options = options.clone();
            let notes_tx = notes_tx.clone();
            let compaction_abort_tx = compaction_abort_tx.clone();
            let prompt_tx = prompt_tx.clone();
            let share_tx = share_tx.clone();
            let reload_tx = reload_tx.clone();
            let traces_upload_tx = traces_upload_tx.clone();
            let update_tx = update_tx.clone();
            let catalog_tx = catalog_tx.clone();
            let auth_panel_tx = auth_panel_tx.clone();
            let heartbeats_tx = heartbeats_tx.clone();
            let bash_tx = bash_tx.clone();
            let commands_tx = commands_tx.clone();
            async move {
                let (client, events) = match first {
                    Some(first) => first,
                    None => DaemonClient::connect(&options.socket_path)
                        .await
                        .with_context(|| "the interactive UI could not attach to the daemon")?,
                };
                let session = SessionUi::open(
                    client,
                    &options,
                    notes_tx,
                    compaction_abort_tx,
                    prompt_tx,
                    share_tx,
                    reload_tx,
                    update_tx,
                    traces_upload_tx,
                    catalog_tx,
                    auth_panel_tx,
                    crate::session_ui::ActivityUpdates {
                        heartbeats: heartbeats_tx,
                        bash: bash_tx,
                        commands: commands_tx,
                    },
                )
                .await?;
                Ok((events, session))
            }
        },
    )
    .await;
    let ((mut events, mut session), waited_for_update_restart) = match open_outcome {
        Ok(opened) => opened,
        Err(error) => {
            // A daemon refusal for the startup create/attach/resume (the
            // daemon is alive and refused THIS request — a remembered id
            // whose worker is gone, or a saved-session create the daemon
            // refuses, e.g. "Session is already active in <id>" while
            // another instance holds the session file): the pane hands off
            // to the agents view with the failure as its status line —
            // the session-picker fallback — instead of dying to the
            // shell. Only transport/protocol failures (daemon down,
            // unanswerable socket) stay fatal.
            //
            // The unknown-session check matches the daemon's RAW refusal
            // message exactly - it must name this attach's own selector -
            // so a selector that happens to contain the phrase could not
            // forge the refusal (and vice versa).
            let unknown_session_refusal = |selector: &str| {
                let expected = format!("Unknown active session: {selector}");
                error.chain().any(|cause| {
                    cause
                        .downcast_ref::<crate::daemon_client::RequestRejected>()
                        .is_some_and(|rejection| rejection.message == expected)
                })
            };
            if let SessionSelection::Attach(selector) = &options.session {
                if unknown_session_refusal(selector) {
                    // The handoff keeps the process alive: disarm the
                    // double-Ctrl+C force-quit watchdog like the normal
                    // agents-view handoff does.
                    exit_guard.cancel();
                    let frames = renderer.finish(&mut view, true);
                    return Ok(InteractiveOutcome {
                        return_to_agents_view: true,
                        agents_view_notice: Some(format!(
                            "Session {selector} is no longer running — pick a session to continue."
                        )),
                        frames,
                        ..Default::default()
                    });
                }
            }
            // A response/handshake timeout (the daemon alive but slow at
            // load: "Timed out after Nms waiting for the Prime Agent daemon
            // response") is a hiccup, not a protocol failure: the same
            // session-picker fallback, never a fatal exit that loses the
            // user's pane (operator directive 2026-09-24 — the attach
            // timeout at box load exited the TUI).
            if crate::daemon_client::is_daemon_timeout(&error) {
                exit_guard.cancel();
                let frames = renderer.finish(&mut view, true);
                return Ok(InteractiveOutcome {
                    return_to_agents_view: true,
                    agents_view_notice: Some(format!("{error:#} — pick a session to continue.")),
                    frames,
                    ..Default::default()
                });
            }
            // Any other daemon refusal (a create the daemon refused for a
            // saved-session open, an admission refusal, ...) gets the same
            // session-picker fallback: the agents view opens with the
            // refusal as its status line and the client never exits.
            if crate::daemon_client::is_daemon_rejection(&error) {
                exit_guard.cancel();
                let frames = renderer.finish(&mut view, true);
                return Ok(InteractiveOutcome {
                    return_to_agents_view: true,
                    agents_view_notice: Some(format!("{error:#}")),
                    frames,
                    ..Default::default()
                });
            }
            // The open wait's deadline failure is the same handoff (TS
            // `runAgentsViewLoop` catches it as "Failed to open agent:"):
            // the guidance to retry once the update finishes must land on
            // the view the user came from — never tear the process down.
            if crate::update_restart_wait::is_update_restart_deadline_error(&error) {
                exit_guard.cancel();
                let frames = renderer.finish(&mut view, true);
                return Ok(InteractiveOutcome {
                    return_to_agents_view: true,
                    agents_view_notice: Some(format!("{error:#}")),
                    frames,
                    ..Default::default()
                });
            }
            // The surface is already up: hand the terminal back before the
            // CLI reports the failure on the plain screen (the same
            // teardown contract as the onboarding exit below).
            if renderer.is_terminal() {
                exit_guard.arm_for_exit();
            }
            renderer.finish(&mut view, false);
            return Err(error);
        }
    };
    session.exit_guard = exit_guard.clone();
    // The supervisor reader's death watch: the event channel itself stays
    // open across a supervisor socket loss (the retained sender keeps it
    // alive for direct reader pumps), so this watch is the observable
    // signal the loop's reconnect driver arms on. Taken from the LIVE
    // session client after the open: an update-restart wait may have
    // retried the open onto a fresh connection (the pre-mount one died
    // with the old daemon), and the watch must name the connection the
    // loop actually serves.
    let mut reader_dead = session.client.reader_dead();
    if headless {
        session.osc_sink = crate::clipboard::OscSink::Buffer(Vec::new());
    }
    session.refresh_stats().await;
    // The startup catalog fetch (TS `updateAvailableProviderCount` →
    // `getConnectionAvailableModels`): failures stay silent and the
    // composition-root snapshot keeps serving the picker.
    session.spawn_model_catalog_refresh();
    session.rebuild_view(&mut view, &crate::session_ui::RebuildKind::Rebind);
    // The cross-view layout handoff's adopt (view::handoff): a re-entry
    // whose attach cursor exactly matches the previous run's held
    // handoff — the same worker, the same event sequence, the same entry
    // count, i.e. a transcript unchanged since the run just left —
    // holds its visible-window packs for the first draw. The first
    // layout preparation validates the render shape, and any chat
    // mutation after this point retires the handoff (the notice folds
    // below included — a startup notice changes the transcript, so the
    // re-entry conservatively re-renders on boxes that show one).
    // A cursor-less re-attach never adopts either (the belt-and-braces
    // companion to the stash-side gate): the store holds no collapsed
    // identity to match, and the adopt side never keys on one.
    if session.attach_cursor_present {
        view.adopt_layout_handoff(
            &session.session_id,
            &session.attach_event_generation,
            session.attach_event_sequence,
        );
    }
    if let Some(notice) = check_tmux_keyboard_setup().await {
        view.push_entry(crate::chat::ChatEntry::Status {
            text: format!("\u{26a0} {notice}"),
            kind: crate::chat::StatusKind::Warning,
        });
        session.dirty = true;
    }
    // TS #2391 `startupNotice`/`updateRestartWaitNotice`: an open that
    // waited through the update restart says so — the session's first
    // status row (the TS `showWarning(startupNotice)` row) and, when the
    // chat hands back to the view, the agents-view status line (the
    // outcome's notice below).
    if waited_for_update_restart {
        let notice = crate::update_restart_wait::DAEMON_UPDATE_RESTART_WAIT_NOTICE;
        view.push_entry(crate::chat::ChatEntry::Status {
            text: format!("\u{26a0} {notice}"),
            kind: crate::chat::StatusKind::Warning,
        });
        session.dirty = true;
    }
    // TS `maybeWarnAboutAnthropicSubscriptionAuth()` at startup (#2645):
    // the ban-risk warning when the session opens on an Anthropic
    // subscription credential.
    if let Some(provider) = session.current_model_provider().await {
        session
            .maybe_warn_anthropic_subscription_auth_if_subscribed(
                Some(provider.as_str()),
                &mut view,
            )
            .await;
    }
    // TS `restorePromptStashOnOpen`: a draft stashed on the way out (a
    // previous chat view of this session left via the agents view or a
    // switch) returns to the editor when its chat reopens.
    session.restore_prompt_stash_on_open(&mut view);
    // Whether the headless plan completed (the plan's final
    // `HeadlessDone`; the run loop's idle gate ends the run on it):
    // declared above the onboarding phase because the pane's drive marks
    // it when the plan completes while the pane owns the input channel.
    let mut headless_done = false;
    // The settle bound's deadline, armed once the plan completes (the
    // gate below ends the run on a full settle; the bound ends it with a
    // named error when a member never drains — see
    // [`HEADLESS_SETTLE_TIMEOUT_MS`]).
    let mut headless_settle_deadline: Option<Instant> = None;
    // Whether the settle gate is waiting out a member: the quiet
    // tick's wake condition reads it (the gate re-checks each
    // wake — see the gate below).
    let mut headless_settle_pending = false;
    // First-run onboarding owns the pane before the session screen (TS
    // `runStartupOnboarding`): a home whose startup model is ready sees
    // the trace question alone, and a not-ready home runs the full
    // sign-in flow. The trace question is the opt-in moment for a fresh
    // home; a home that already carries a standing choice completes
    // silently, and the phase's own marker gate keeps it one-shot across
    // the agents-view loop's sessions.
    if let Some(task) = options.onboarding.clone() {
        let mut drive = PaneDrive {
            ui_rx: &mut ui_rx,
            renderer: &mut renderer,
            exit_guard: &exit_guard,
            keybindings: view.editor.keybindings().clone(),
            auth_panel_rx: &mut auth_panel_rx,
            headless_done: &mut headless_done,
        };
        let exit_requested =
            run_onboarding_phase(&task, &mut session, &mut view, &mut drive).await?;
        if exit_requested {
            // The exit deadline is armed from the moment the run decides to
            // leave: no cleanup below may block past it.
            exit_guard.arm_for_exit();
            session.detach_for_exit().await;
            // The user quit at the onboarding screen: still hand the
            // terminal back (raw mode off, alt screen left and flushed)
            // exactly like a session exit.
            renderer.finish(&mut view, false);
            return Ok(InteractiveOutcome {
                active_session_id: session.active_session_id.clone(),
                session_id: session.session_id.clone(),
                resume_hint: None,
                last_assistant_text: None,
                frames: Vec::new(),
                clipboard_emissions: Vec::new(),
                agents_view_scope: None,
                // Onboarding exit leaves no session open; no return-to-view
                // or pending selection applies.
                return_to_agents_view: false,
                selection_request: None,
                copies: Vec::new(),
                opened_urls: Vec::new(),
                agents_view_notice: None,
                handoff_seeds: 0,
            });
        }
    }
    if let Some(initial) = &options.initial_message {
        session
            .submit_prompt(initial, crate::session_ui::SubmitBehavior::Steer, &mut view)
            .await?;
    }

    let mut pending: VecDeque<UiInput> = VecDeque::new();
    let mut last_bash_refresh = Instant::now();
    // The enhanced-key modes settle once (kitty answer or fallback) and
    // report one adoption event; headless runs hold pipes and never probe.
    let mut enhanced_keys_pending = renderer.is_terminal();
    // The hyperlink capability is env-based and settles at run start (no
    // probe round-trip like the kitty keyboard protocol); terminal runs
    // report it once alongside the enhanced-key modes.
    let mut hyperlinks_pending = renderer.is_terminal();
    // The frame scheduler (TS `requestRender` + `scheduleRender`): state
    // changes coalesce, and the loop paints at most one frame per
    // MIN_RENDER_INTERVAL_MS. `last_render_at` is `None` before the first
    // frame, `render_deadline` is armed while a dirty frame waits out the
    // interval.
    let mut last_render_at: Option<Instant> = None;
    let mut render_deadline: Option<Instant> = None;
    let mut anim_started: Option<Instant> = None;
    // The spinner phase painted by the last frame (`usize::MAX` before the
    // first): a quiet turn only dirties when the 80ms phase advances, not
    // on every loop tick.
    let mut last_pulse_phase: usize = usize::MAX;
    // Whether the Ctrl+C exit hint painted a frame that the expiry must
    // clear (TS `showCtrlCExitHint`'s timer repaints it away; without the
    // flag the loop cannot tell an armed hint from one that just
    // expired between iterations).
    let mut hint_painted = false;
    let mut running = true;
    let mut wait_idle_deadline: Option<Instant> = None;
    // The headless render barrier's armed state: its deadline, and the
    // frames captured at arming (the `WaitRender` condition scans only
    // frames rendered after the barrier became the queue's head, so a
    // needle that already scrolled out of an older frame still satisfies
    // it; `WaitGone` checks only the newest frame).
    let mut wait_render_deadline: Option<Instant> = None;
    let mut wait_render_baseline: usize = 0;
    // Spec §10.2: the reconnect loop after a `daemon_closing` update frame.
    // Retry with backoff for up to RECONNECT_WINDOW; each attempt reads the
    // successor's hello (`update_resume`, §10.3) and reattaches by durable
    // session id (§10.4 - the supervisor queues the attach behind any
    // restore still in flight). UI input keeps flowing while reconnecting,
    // so the user can leave with Ctrl+C instead of riding out the window.
    let mut reconnect: Option<ReconnectLoop> = None;
    // The in-flight reconnect attempt's connect leg (spawned off the loop,
    // so the attempt's connect+hello wait never blocks UI input or the
    // render; the reattach leg runs inline on the loop under its own
    // bound).
    let mut reconnect_connect: Option<ReconnectConnect> = None;
    // Mirrors `reconnect_connect`'s in-flight state as a plain copy so the
    // tick arm's future can park without borrowing the attempt receiver
    // (the attempt arm owns its mutable borrow).
    let mut reconnect_attempt_in_flight = false;
    // The reader-death watch is one-shot: once the loss is handled (or
    // suppressed behind a live direct link), the arm parks so the closed
    // watch cannot hot-spin the select loop.
    let mut reader_loss_handled = false;
    // The supervisor connection died while a live direct link kept serving
    // the session: the loss is retained (not recovered — replacing the
    // client would churn the working link) until the direct link itself
    // dies; then the full reconnect driver owns the recovery instead of
    // the session-plane retry loop, which would ride a dead supervisor.
    let mut supervisor_lost = false;
    // Set once the event channel has returned None (a closed connection's
    // recv() resolves None instantly and forever — see the events arm).
    let mut events_closed = false;
    // The session re-attach driver: armed when the direct worker link dies
    // (a killed or crashed worker); it re-attaches through the supervisor
    // so the respawned worker serves the session again.
    let mut session_reconnect: Option<SessionReconnect> = None;

    'run: while running {
        // The enhanced-key modes settle once per run: the kitty probe
        // answered, or the modifyOtherKeys fallback fired. One adoption
        // event reports the established combination.
        if enhanced_keys_pending {
            if let Some((kitty, modify_other_keys)) = crate::enhanced_keys::settle_state() {
                if let Some(telemetry) = &session.telemetry {
                    telemetry.enhanced_keys(kitty, modify_other_keys).await;
                }
                enhanced_keys_pending = false;
            }
        }

        // The OSC 8 hyperlink capability settles once per run with the
        // terminal identity the paint backend binds to: one adoption event
        // reports the gate (`tui hyperlinks`). The one-shot client's
        // flush shutdown can wait out a slow telemetry endpoint, so the
        // event is spawned instead of awaited - the run's first frame and
        // input handling never block on it.
        if hyperlinks_pending {
            if let Some(telemetry) = session.telemetry.clone() {
                let enabled = crate::hyperlinks::hyperlinks_enabled();
                tokio::spawn(async move {
                    telemetry.hyperlinks_active(enabled).await;
                });
            }
            hyperlinks_pending = false;
        }

        // Drain the whole queued input batch in this one iteration (TS
        // `handleInput` dispatches every event of a stdin chunk, then
        // schedules one render): a burst of wheel turns or held keys
        // applies as one batch instead of one full-layout render pass per
        // event, and an exit key queued behind a burst lands in the same
        // batch — the loop never spends its cycles behind a backlog the
        // user cannot escape. A WaitIdle step is a barrier: it stays at the
        // head of the queue until the turn finishes (or its deadline),
        // holding everything queued behind it.
        let mut inputs_pending = !pending.is_empty();
        while inputs_pending {
            if let Some(UiInput::WaitIdle { timeout_ms }) = pending.front() {
                let timeout_ms = *timeout_ms;
                // A parked follow-up/steering message keeps the barrier waiting
                // until the session delivers it (the queue strip must clear
                // before the next step observes the frames). A submit whose
                // round trip is still armed holds the barrier too: the async
                // submit resolves off the render path (the inline submit
                // held the barrier by blocking the loop until its ack
                // landed), so the outcome must land before the barrier can
                // read idle.
                if session.turn_active
                    || !view.queued.is_empty()
                    || session.prompt_submits_in_flight() > 0
                {
                    if wait_idle_deadline.is_none() {
                        wait_idle_deadline =
                            Some(Instant::now() + Duration::from_millis(timeout_ms));
                    } else if Instant::now() > wait_idle_deadline.unwrap() {
                        wait_idle_deadline = None;
                        pending.pop_front();
                        session.note("timed out waiting for the turn to finish", &mut view);
                    }
                    // The barrier holds the batch: the queued inputs stay
                    // until the turn delivers them.
                    inputs_pending = false;
                } else {
                    wait_idle_deadline = None;
                    pending.pop_front();
                }
            } else if let Some((needle, timeout_ms, present)) = match pending.front() {
                Some(UiInput::WaitRender { needle, timeout_ms }) => {
                    Some((needle.clone(), *timeout_ms, true))
                }
                Some(UiInput::WaitGone { needle, timeout_ms }) => {
                    Some((needle.clone(), *timeout_ms, false))
                }
                _ => None,
            } {
                // The render barrier: `WaitRender` holds until a frame
                // rendered after arming contains the needle (daemon-driven
                // rows land on the loop's event/tick cadence, so this rides
                // out any load latency instead of a fixed wall-clock
                // window); `WaitGone` holds until the newest frame cleared
                // it. Frames captured before the barrier reached the queue
                // head never satisfy it — the baseline is recorded at
                // arming and only subsequent frames count, except for the
                // newest frame at arming time (the current state: a
                // condition that already holds pops immediately instead of
                // stalling on a repaint that may never come). Like the
                // idle barrier it holds the whole queued batch behind it,
                // and its timeout pops with a note (the note never embeds
                // the needle: the note row renders into frames, and quoting
                // the needle would make a timed-out wait satisfy the very
                // condition that failed).
                let current_state_ok = renderer.headless_frames().is_some_and(|frames| {
                    frames
                        .last()
                        .is_some_and(|frame| frame.contains(needle.as_str()) == present)
                });
                if wait_render_deadline.is_none() {
                    if current_state_ok {
                        pending.pop_front();
                    } else {
                        wait_render_baseline =
                            renderer.headless_frames().map_or(0, <[String]>::len);
                        wait_render_deadline =
                            Some(Instant::now() + Duration::from_millis(timeout_ms));
                        inputs_pending = false;
                    }
                } else {
                    let satisfied = renderer.headless_frames().is_some_and(|frames| {
                        if present {
                            frames
                                .get(wait_render_baseline..)
                                .unwrap_or_default()
                                .iter()
                                .any(|frame| frame.contains(needle.as_str()))
                        } else {
                            !frames
                                .last()
                                .is_some_and(|frame| frame.contains(needle.as_str()))
                        }
                    });
                    if satisfied {
                        wait_render_deadline = None;
                        pending.pop_front();
                    } else if Instant::now() > wait_render_deadline.unwrap() {
                        wait_render_deadline = None;
                        pending.pop_front();
                        session.note(
                            if present {
                                "timed out waiting for the headless render condition"
                            } else {
                                "timed out waiting for the headless render to clear"
                            },
                            &mut view,
                        );
                    } else {
                        // The barrier holds the batch while the render
                        // catches up.
                        inputs_pending = false;
                    }
                }
            } else if let Some(input) = pending.pop_front() {
                session.dirty = true;
                match input {
                    UiInput::Key(key) => {
                        // TS stops the selection auto-scroll on every
                        // non-mouse input (`handleFullscreenInput`).
                        session.stop_selection_auto_scroll();
                        match session.handle_key(key, &mut view, &mut running).await {
                            Ok(()) => {}
                            // A daemon refusal answered this key's request
                            // (the connection stays healthy), or the
                            // connection could not carry it at all (a
                            // timeout on a sent request, a down or
                            // reconnecting daemon): the TS `showError` row
                            // surfaces it and the loop keeps running with
                            // the editor state preserved — a failed request
                            // never exits the client while the reconnect
                            // driver owns the recovery (the operator's
                            // kicked-out class).
                            Err(error)
                                if crate::daemon_client::is_daemon_rejection(&error)
                                    || crate::daemon_client::is_daemon_unreachable(&error) =>
                            {
                                session.error_row(&format!("{error:#}"), &mut view);
                            }
                            // Everything else (protocol corruption) stays
                            // fatal.
                            Err(error) => return Err(error),
                        }
                        // TS `handleCtrlZ` (`app.suspend`, default ctrl+z):
                        // hand the terminal to the shell and stop the process
                        // group; execution continues here once the user
                        // foregrounds the process (SIGCONT), where the cycle
                        // re-applies raw mode, the alt screen, and SGR mouse
                        // tracking (TS `ui.start()` + `applyFullscreen(true)`).
                        // Headless runs keep no terminal renderer (TS never
                        // registers the action without one), so the request is
                        // observed and dropped.
                        // A parked `/traces login` (or the enable arm's
                        // login-first step): mount the inline auth panel
                        // and spawn the flow (the panel channel carries
                        // its requests and the settled outcome).
                        if session.pending_traces_login() {
                            session.run_traces_login(&mut view);
                        }
                        if session.take_suspend_request() && renderer.is_terminal_mut().is_some() {
                            match crate::suspend::suspend_cycle(
                                &mut crate::suspend::ProcessSignals,
                                &mut TerminalHandoff {
                                    renderer: &mut renderer,
                                    view: &mut view,
                                },
                            ) {
                                Ok(()) => session.track_suspend_used("resumed"),
                                Err(error) => {
                                    session.track_suspend_used("failed");
                                    session.error_row(&format!("{error:#}"), &mut view);
                                    // Try to take the terminal back so the run
                                    // stays usable; if that also fails, the
                                    // draw below surfaces the broken frame.
                                    let _ = renderer.resume();
                                }
                            }
                        }
                        // TS `openExternalEditor`: hand the terminal to the
                        // editor, then resume. The input reader would steal
                        // the editor's keys, so it stops (flag + join) and
                        // respawns after the resume. Headless runs drop it.
                        if let Some(command) = session.take_external_editor_request() {
                            let reader = match &renderer {
                                Renderer::Terminal {
                                    ui_tx, exit_guard, ..
                                } => Some((ui_tx.clone(), exit_guard.clone())),
                                Renderer::Headless { .. } => None,
                            };
                            if let Some((ui_tx, exit_guard)) = reader {
                                crate::input::stop_reader();
                                // The suspend path's SIGINT shield: the
                                // handoff restores cooked mode (ISIG), and
                                // a cooked-mode editor wrapper (`code
                                // --wait`, `subl -w`) turns Ctrl+C into
                                // SIGINT for the shared foreground group —
                                // the default disposition would kill the
                                // TUI mid-edit. The no-op handler (never
                                // SIG_IGN) keeps the child's own Ctrl+C:
                                // handled signals reset to the default
                                // across exec.
                                let mut signals = crate::suspend::ProcessSignals;
                                let shielded = if crate::suspend::supported() {
                                    use crate::suspend::SuspendSignals;
                                    signals.ignore_sigint()
                                } else {
                                    Ok(())
                                };
                                let stopped = shielded.and_then(|()| {
                                    TerminalHandoff {
                                        renderer: &mut renderer,
                                        view: &mut view,
                                    }
                                    .stop()
                                });
                                let outcome = match stopped {
                                    Ok(()) => {
                                        crate::external_editor::edit(
                                            &command,
                                            &view.editor.get_expanded_text(),
                                        )
                                        .await
                                    }
                                    Err(error) => Err(error),
                                };
                                // The suspend cycle's order: SIGINT is
                                // back to the default before the surface
                                // takes the terminal.
                                if crate::suspend::supported() {
                                    use crate::suspend::SuspendSignals;
                                    let _ = signals.restore_sigint();
                                }
                                // TS resumes in a `finally`: the surface
                                // returns even when the editor run failed.
                                let resumed = TerminalHandoff {
                                    renderer: &mut renderer,
                                    view: &mut view,
                                }
                                .resume();
                                if let Err(error) = resumed {
                                    session.error_row(&format!("{error:#}"), &mut view);
                                }
                                spawn_session_reader(ui_tx, exit_guard);
                                session.apply_external_editor_outcome(outcome, &mut view);
                            }
                        }
                        // The `/mcp` view resolved to an auth request (its
                        // Enter on a connection, or the pasteable service's
                        // paste flow): mount the inline auth panel and spawn
                        // the client auth command against it — the
                        // typed-command arg path is gone, so the view never
                        // resolves through a submitted `/mcp <args>`
                        // string, and no flow touches the terminal.
                        if session.pending_mcp_auth() {
                            session.run_mcp_auth(&mut view);
                        }
                    }
                    UiInput::Paste(text) => {
                        session.stop_selection_auto_scroll();
                        // The inline auth panel owns the frame: the paste
                        // lands in its field, never in the editor behind
                        // it.
                        if view.auth_panel.is_some() {
                            session.paste_to_auth_panel(&text, &mut view);
                        } else {
                            session.handle_paste(&text, &mut view);
                        }
                    }
                    // A mouse report reaches the transcript scroll dispatch
                    // (TS `handleFullscreenInput`'s wheel branch); non-wheel
                    // reports are consumed inside.
                    UiInput::Mouse(event) => {
                        session.handle_mouse(event, &mut view);
                    }
                    // The headless plan's pause step: the queued keystroke
                    // batch ahead of this barrier is fully handled, so the
                    // parked suggestions materialize now — the same state the
                    // terminal loop's 50 ms idle tick produces after a real
                    // user pauses typing.
                    UiInput::SettleIdle => {
                        session.materialize_editor_autocomplete(&mut view);
                    }
                    UiInput::Submit(text) => {
                        session.stop_selection_auto_scroll();
                        // No submitted text needs the terminal: the
                        // `/mcp` typed-arg form is gone (its login flow
                        // resolved through the view's own auth seam above).
                        let dispatched = session
                            .submit_prompt(
                                &text,
                                crate::session_ui::SubmitBehavior::Steer,
                                &mut view,
                            )
                            .await;
                        if let Err(error) = dispatched {
                            // TS: a rejected submission surfaces the `⚠ Error`
                            // row and keeps the client mounted with the draft
                            // restored — a failed prompt never exits the UI.
                            session.error_row(&format!("{error:#}"), &mut view);
                            view.editor.set_text(&text);
                            session.dirty = true;
                        }
                        // A parked `/traces login` (or the enable arm's
                        // login-first step): mount the inline auth panel and
                        // spawn the flow (the Submit path needs the same
                        // dispatch the Key path has — headless plans drive
                        // commands as submissions).
                        if session.pending_traces_login() {
                            session.run_traces_login(&mut view);
                        }
                    }
                    UiInput::HeadlessDone => headless_done = true,
                    UiInput::WaitRender { .. } | UiInput::WaitGone { .. } => {
                        unreachable!("render barrier handled above")
                    }
                    UiInput::ScrollTop => {
                        session.stop_selection_auto_scroll();
                        view.scroll_to_top();
                    }
                    UiInput::Resize => {
                        session.stop_selection_auto_scroll();
                        // The editor lays its window out against the new row
                        // count; the branch's dirty flag repaints the frame at
                        // the new geometry.
                        if let Ok((_width, height)) = crossterm::terminal::size() {
                            view.set_terminal_rows(height);
                        }
                    }
                    UiInput::WaitIdle { .. } => unreachable!("barrier handled above"),
                }
                // Paint the handled input in this iteration: the select below can
                // otherwise wait out its 50ms tick before the next draw, and
                // that wait is felt directly as keystroke-to-render lag.
                // A handoff paints nothing: the next surface owns the pane
                // (TS `returnToAgentsView` hands the terminal over without a
                // final repaint — the agents view's mount clears the alt
                // screen), so the chat's last layout is dead work that only
                // delays the switch.
                if let Some(renderer) = renderer.is_terminal_mut() {
                    if !session.open_agents_view && session.pending_selection.is_none() {
                        // The inline paint must reflect tray state the
                        // handled key just armed (the Ctrl+C exit hint:
                        // TS `showCtrlCExitHint` requestRender's on the
                        // key). The loop's refresh below the select only
                        // reaches the frame gate, and the inline paint
                        // clears `dirty` — an idle terminal would
                        // otherwise never show the armed hint.
                        view.chrome.tray_override = session.tray_override(&view);
                        crate::app::draw(renderer, &mut view)?;
                        // The frame scheduler's bookkeeping follows the
                        // inline paint: the 16ms gate below now measures its
                        // interval from this frame, and a paint satisfied
                        // any armed deadline.
                        last_render_at = Some(Instant::now());
                        last_pulse_phase = view.pulse_frame;
                        render_deadline = None;
                    }
                    session.dirty = false;
                }
                // An exit key must not wait out the select tick before the
                // bounded shutdown path runs.
                if !running {
                    break;
                }
                // `exit_requested` is the same leave-now signal (agents-back,
                // `/resume`, `/exit`): in terminal mode the teardown below must
                // run this iteration, not after the select's 50ms idle tick
                // parks the loop — that park reads directly as switch latency
                // (TS's event loop leaves on the key). A HANDOFF takes the
                // leave now: the bare `break` below only leaves the
                // input-drain loop, and the select after it parks the exit
                // for the tick — measured as ~50ms of chat->agents switch
                // latency on every handoff. The handoff's next surface owns
                // the pane (its mount clears the alt screen), so nothing the
                // tail pass paints can reach the user. A non-handoff exit
                // (`/exit`, `/quit`) keeps the tail pass: its frame gate
                // paints the final chat frame the exit's main-screen flush
                // shows. Headless runs keep the tail pass so captured
                // frames stay identical.
                if renderer.is_terminal()
                    && session.exit_requested
                    && (session.open_agents_view || session.pending_selection.is_some())
                {
                    session.exit_reason = "session_request";
                    break 'run;
                }
                if session.exit_requested && renderer.is_terminal() {
                    session.exit_reason = "session_request";
                    break;
                }
                // Headless input keeps the one-step-per-iteration order the
                // plans were written against: every step renders before the
                // next applies (a plan step is not a terminal burst, and the
                // captured frame sequence IS the verifier evidence — a
                // batched drain would collapse intermediate states like the
                // expanded compaction block or an open panel out of the
                // capture). The terminal path keeps the full batch
                // drain, the input-starvation fix.
                if !renderer.is_terminal() {
                    inputs_pending = false;
                }
            } else {
                // The batch drained: everything queued was handled in this
                // one pass (TS dispatches a stdin chunk's events the same
                // way). Without this arm the drain loop would spin on the
                // empty queue — the select below would never run again,
                // starving every render and input after the first batch
                // (the trapped, 90%+ CPU state the dogfood hit).
                inputs_pending = false;
            }
        }
        // The headless exit gate: the plan completed, and the run ends
        // once every settle member drains (a `/share` upload in flight
        // holds the run open like an active turn — the headless harness
        // must not finish before its outcome rows land, and an inline
        // auth flow is work like an upload; a live terminal never ends
        // the run on its own). The members are snapshotted so the bound
        // below can name exactly what stuck.
        let settle = headless_done.then(|| {
            HeadlessSettle::snapshot(&session, &view, pending.len(), wait_idle_deadline.is_some())
        });
        if let Some(settle) = settle {
            if settle.settled() {
                break;
            }
            // The settle bound: the gate's wait is the harness's only
            // unbounded one (TS exits the process at shutdown and lets
            // in-flight work dangle), so a member that never drains
            // fails the run with its name instead of wedging the test
            // binary forever (the CI wedge family: a 30-45min job
            // budget with no failure row).
            headless_settle_pending = true;
            let deadline = headless_settle_deadline
                .get_or_insert(Instant::now() + Duration::from_millis(HEADLESS_SETTLE_TIMEOUT_MS));
            if Instant::now() >= *deadline {
                anyhow::bail!(
                    "the headless run's settle did not complete within {}ms of the plan's completion: {}",
                    HEADLESS_SETTLE_TIMEOUT_MS,
                    settle.blockers().join("; ")
                );
            }
        }

        // An exit key must not wait out the select: the loop condition
        // consumes `running`/`exit_requested` at the NEXT wake, and the
        // input batch's bare `break` only leaves the batch — the select
        // after it parks the exit (the old unconditional quiet tick was
        // the guaranteed ≤50ms wake; with the tick parked on idle work,
        // an exit on an otherwise idle surface would wait for whatever
        // timer happens to be armed). The frame arm is the one that can
        // wake now, so a pending exit takes it immediately: the tail
        // pass paints its final frame and the loop condition runs within
        // the same iteration, strictly sooner than the tick ever did.
        if (!running || session.exit_requested)
            && render_deadline.is_none_or(|deadline| deadline > Instant::now())
        {
            render_deadline = Some(Instant::now());
        }
        // The frame-wake inventory: every pending-work state whose
        // observation needs a loop iteration arms the frame deadline
        // here, pre-select — the states the old unconditional tick
        // used to observe implicitly. A dirty frame (the open's first
        // paint; a keystroke's toast or hint) must not park behind a
        // select that has no other wake: the frame gate that paints
        // it runs at the iteration's tail. The headless barriers'
        // deadlines re-check at the loop top, and the hint/toast
        // expiry arms live HERE, not after the frame gate (a parked
        // select would never reach a post-gate arm; a paint's
        // deadline wipe only happens after the wake already fired,
        // and the next iteration re-arms while the state persists).
        if session.dirty && render_deadline.is_none() {
            render_deadline = Some(Instant::now());
        }
        for deadline in [wait_idle_deadline, wait_render_deadline]
            .into_iter()
            .flatten()
        {
            if render_deadline.is_none_or(|armed| deadline < armed) {
                render_deadline = Some(deadline);
            }
        }
        if let Some(expiry) = session.ctrl_c_hint_expiry() {
            if render_deadline.is_none_or(|armed| expiry < armed) {
                render_deadline = Some(expiry);
            }
        }
        if let Some(expiry) = view.toasts.next_expiry() {
            if render_deadline.is_none_or(|armed| expiry < armed) {
                render_deadline = Some(expiry);
            }
        }
        let was_active = session.turn_active;
        // The quiet tick's arming state, snapshotted before the select:
        // parked autocomplete requests and an armed selection auto-scroll
        // are the only work the tick exists for, and the arm future reads
        // these locals instead of borrowing the surface.
        let autocomplete_pending = view.editor.has_pending_autocomplete();
        let auto_scroll_armed = session.selection_auto_scroll_armed();
        let bash_refresh_wanted = session.kernel_bash_supported();
        // A settle waiting out a member is pending work like the
        // autocomplete park: the gate runs at the loop top, so its
        // re-check (and the settle bound's expiry) needs this arm's
        // wake — a fully quiet select would otherwise park the
        // settle forever, and the bound itself fires only on an
        // iteration. Terminal runs never arm it (`headless_done`
        // exists only on the headless harness).
        let settle_recheck_wanted = headless_done && headless_settle_pending;
        tokio::select! {
            maybe_event = async {
                // A closed channel's recv() resolves None instantly and
                // forever; while the reconnect driver owns the run (§10.2)
                // that always-ready arm would hot-spin the loop and starve
                // the tokio timers (the reconnect tick, the frame
                // deadline). Park the arm instead: the tick drives the
                // retries until the successor connection replaces the
                // channel.
                if events_closed && reconnect.is_some() {
                    std::future::pending::<()>().await;
                }
                events.recv().await
            } => {
                                if let Some(event) = maybe_event {
                    session.apply_client_event(event, &mut view);
                    // Batch the rest of the queued frames before this
                    // iteration's render: a stream burst applies as one
                    // transcript pass instead of one full re-layout per
                    // frame (a replay-scale ingest renders once per
                    // batch, not once per row).
                    while let Ok(event) = events.try_recv() {
                        session.apply_client_event(event, &mut view);
                    }
                    // A succeeded compaction rebuilt the durable
                    // transcript: replace the view's chat with it, and
                    // refresh the tray usage the same way a settled
                    // turn does (TS refreshes after "a turn or
                    // compaction completes" — post-compaction usage is
                    // unknown until the next assistant response).
                    if session.transcript_stale {
                        session.rebuild_transcript(&mut view).await;
                        session.refresh_stats().await;
                        session.rebuild_tray(&mut view);
                    }
                    // A settled turn refreshes the tray's context usage.
                    if was_active && !session.turn_active {
                        session.refresh_stats().await;
                        session.rebuild_tray(&mut view);
                    }
                    // A `session_binding` supersede notice: the session
                    // lives under a new active id, so re-attach to it -
                    // event routing follows the attach, and the
                    // transcript rebuilds from the snapshot (silent, no
                    // banner). A failed re-attach changes nothing: the
                    // new attach never landed, so the pane keeps its
                    // current id and subscription (the old one detaches
                    // only after a new attach succeeds); the next
                    // supersede notice or the submit-path retry
                    // re-attaches once a worker can serve the session.
                    if let Some(current) = session.pending_rebind.take() {
                        match session
                            .attach_session(&current, crate::session_ui::DockFold::FirstFrame)
                            .await
                        {
                            Ok(()) => session.rebuild_view(
                                &mut view,
                                &crate::session_ui::RebuildKind::Rebind,
                            ),
                            Err(error) => session.note(
                                &format!("session rebind failed: {error:#}"),
                                &mut view,
                            ),
                        }
                    }
                    // An update close frame arms the reconnect driver
                    // immediately: the doomed connection's reader task is
                    // gone, but the client struct retains an event
                    // sender, so the channel itself never closes - the
                    // frame, not the EOF, is the trigger (spec §10.2).
                    // An update closing outranks a shutdown recovery in
                    // flight (TS #2458): the §10.2 resume contract replaces
                    // it.
                    if let Some(update) = session.reconnect.take() {
                        session.note(
                            &format!(
                                "the daemon is restarting for an update (about {}s) — reconnecting…",
                                update.est_seconds.max(1)
                            ),
                            &mut view,
                        );
                        reconnect = Some(ReconnectLoop::start(&update));
                        session.dirty = true;
                    }
                    // An announced non-update closing arms the bounded
                    // shutdown recovery instead (TS #2458): no-op unless
                    // the notice says the daemon itself is going down.
                    arm_shutdown_recovery(
                        &mut session,
                        &mut view,
                        &mut reconnect,
                        &mut session_reconnect,
                    );
                    // A dead direct worker link arms the session
                    // re-attach driver (TS `connection_status:
                    // "reconnecting"`): the warning row rides the chat
                    // while the driver retries the attach.
                    if session_reconnect.is_none() {
                        if let Some(lost) = session.transport_lost.take() {
                            // A supervisor loss retained while the direct
                            // link lived: the supervisor client is dead,
                            // so the session-plane retry loop could never
                            // restore it — the full reconnect driver
                            // replaces the client and reattaches.
                            if supervisor_lost && reconnect.is_none() {
                                session.note_as(
                                    "the daemon connection closed — reconnecting…",
                                    crate::chat::StatusKind::Warning,
                                    &mut view,
                                );
                                reconnect = Some(ReconnectLoop::start_lost());
                                supervisor_lost = false;
                            } else if reconnect.is_some() {
                                // TS #2458: a full reconnect driver (an
                                // update restart, or the announced
                                // shutdown's recovery) owns the run — the
                                // dead direct link joins it instead of
                                // racing a session-plane retry through a
                                // supervisor it cannot reach.
                            } else {
                                session.note_as(
                                    "Daemon connection lost; reconnecting…",
                                    crate::chat::StatusKind::Warning,
                                    &mut view,
                                );
                                session_reconnect = Some(SessionReconnect::start(&lost));
                            }
                            session.dirty = true;
                        }
                    }
                } else {
                    events_closed = true;
                    if let Some(update) = session.reconnect.take() {
                        // §10: an update restart closed the daemon; the
                        // UI stays mounted and reconnects.
                        session.note(
                            &format!(
                                "the daemon is restarting for an update (about {}s) — reconnecting…",
                                update.est_seconds.max(1)
                            ),
                            &mut view,
                        );
                        reconnect = Some(ReconnectLoop::start(&update));
                        session.dirty = true;
                    } else if arm_shutdown_recovery(
                        &mut session,
                        &mut view,
                        &mut reconnect,
                        &mut session_reconnect,
                    ) {
                        // TS #2458: the announced non-update closing owns
                        // the recovery, not the hiccup loop.
                    } else if reconnect.is_some() {
                        // Already reconnecting: the dead channel's
                        // terminal None frames are expected.
                    } else {
                        // An unexpected connection loss (no update in
                        // flight) is a daemon hiccup, not a session
                        // end: the pane keeps its transcript and
                        // retries with the same bounded window and
                        // backoff as the update restart. The user
                        // can leave at any point; the window expires
                        // into the honest exit note.
                        session.note_as(
                            "the daemon connection closed — reconnecting…",
                            crate::chat::StatusKind::Warning,
                            &mut view,
                        );
                        reconnect = Some(ReconnectLoop::start_lost());
                        session.dirty = true;
                    }
                }
            }
            reader_death = async {
                // One-shot: after the loss is handled (or suppressed), park
                // the arm — the watch stays closed for the rest of the run
                // and a ready arm would hot-spin the select.
                if reader_loss_handled {
                    std::future::pending::<()>().await;
                }
                reader_dead.changed().await
            } => {
                reader_loss_handled = true;
                if reader_death.is_ok() && *reader_dead.borrow_and_update() {
                    // An update restart's close frame can race this signal
                    // (the reader emits the frame, then dies — the unbiased
                    // select may run this arm first): drain every frame the
                    // reader already delivered — a pending `daemon_closing`
                    // sets the update state — before deciding, so the
                    // update's own reconnect driver owns the recovery and
                    // the loss driver never takes over from it.
                    while let Ok(event) = events.try_recv() {
                        session.apply_client_event(event, &mut view);
                    }
                    if session.reconnect.is_some() {
                        session.dirty = true;
                    } else if arm_shutdown_recovery(
                        &mut session,
                        &mut view,
                        &mut reconnect,
                        &mut session_reconnect,
                    ) {
                        // The announced non-update closing owns the
                        // recovery (TS #2458): the supervisor socket's
                        // death joins its driver — the direct link below
                        // must not retain the loss behind it.
                    } else if session.client.direct_session_id().is_some() {
                        // A supervisor socket loss while a live direct link
                        // still serves the session is not a pane-level loss
                        // (session-plane commands ride the link): retain
                        // the loss instead of recovering, and hand it to
                        // the full reconnect driver when the direct link
                        // later dies.
                        supervisor_lost = true;
                    } else if session_reconnect.is_some() {
                        // The direct link already died and the session-plane
                        // driver is retrying through the NOW-DEAD
                        // supervisor: stop it (it would ride a dead client)
                        // and hand the recovery to the full driver.
                        session_reconnect = None;
                        if reconnect.is_none() {
                            session.note_as(
                                "the daemon connection closed — reconnecting…",
                                crate::chat::StatusKind::Warning,
                                &mut view,
                            );
                            reconnect = Some(ReconnectLoop::start_lost());
                        }
                        session.dirty = true;
                    } else if reconnect.is_none() {
                        session.note_as(
                            "the daemon connection closed — reconnecting…",
                            crate::chat::StatusKind::Warning,
                            &mut view,
                        );
                        reconnect = Some(ReconnectLoop::start_lost());
                        session.dirty = true;
                    }
                }
            }
            maybe_input = async {
                // The headless driver drops its sender after HeadlessDone.
                // A closed recv is always ready and would starve turn events
                // while the final submitted prompt is still settling.
                if headless_done {
                    std::future::pending::<Option<UiInput>>().await
                } else {
                    ui_rx.recv().await
                }
            } => {
                if let Some(input) = maybe_input {
                    pending.push_back(input);
                }
            }
            maybe_note = notes_rx.recv() => {
                if let Some(note) = maybe_note {
                    session.apply_background_note(&note, &mut view);
                }
            }
            maybe_compaction_abort = compaction_abort_rx.recv() => {
                if let Some(outcome) = maybe_compaction_abort {
                    session.apply_compaction_abort_outcome(outcome, &mut view);
                }
            }
            maybe_share = share_rx.recv() => {
                if let Some(outcome) = maybe_share {
                    session.apply_share_outcome(outcome, &mut view);
                }
            }
            maybe_update = update_rx.recv() => {
                if let Some(outcome) = maybe_update {
                    session.apply_update_note(outcome, &mut view);
                }
            }
            maybe_reload = reload_rx.recv() => {
                if let Some(outcome) = maybe_reload {
                    session.apply_reload_outcome(outcome, &mut view).await;
                }
            }
            maybe_traces_upload = traces_upload_rx.recv() => {
                if let Some(note) = maybe_traces_upload {
                    session.apply_traces_upload_note(note, &mut view);
                }
            }
            maybe_catalog = catalog_rx.recv() => {
                if let Some(update) = maybe_catalog {
                    session.apply_model_catalog(update, &mut view);
                }
            }
            maybe_auth_panel = auth_panel_rx.recv() => {
                if let Some(request) = maybe_auth_panel {
                    session.apply_auth_panel_request(request, &mut view).await;
                }
            }
            maybe_heartbeats = heartbeats_rx.recv() => {
                if let Some(update) = maybe_heartbeats {
                    session.apply_heartbeat_update(update, &mut view);
                }
            }
            maybe_bash = bash_rx.recv() => {
                if let Some(update) = maybe_bash {
                    session.apply_bash_activity(update, &mut view);
                }
            }
            maybe_commands = commands_rx.recv() => {
                if let Some(update) = maybe_commands {
                    session.apply_command_catalog(update, &mut view);
                }
            }
            maybe_prompt = prompt_rx.recv() => {
                if let Some(note) = maybe_prompt {
                    // Protocol corruption stays fatal exactly like the
                    // inline submit's ladder (the handle-key catch's
                    // "everything else" arm).
                    session.apply_prompt_outcome(note, &mut view).await?;
                }
            }
            _reconnect_tick = async {
                // Park the tick while an attempt is in flight: the armed
                // `next_attempt` is in the past (the attempt consumed it),
                // so an unparked tick would resolve instantly and
                // busy-spin the loop for the attempt's duration.
                if reconnect_attempt_in_flight {
                    std::future::pending::<()>().await;
                }
                match reconnect.as_ref() {
                    Some(state) => tokio::time::sleep_until(state.next_attempt).await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                if reconnect_connect.is_some() {
                    continue;
                }
                let (deadline, kind) = match reconnect.as_ref() {
                    Some(state) => (state.deadline, state.kind),
                    None => continue,
                };
                if tokio::time::Instant::now() > deadline {
                    match kind {
                        RecoveryKind::Shutdown => {
                            // TS #2458: the daemon never came back within
                            // the reconnect timeout — the saved-transcript
                            // close (the session file survives on disk).
                            session.note(
                                "The Prime Agent daemon shut down while this window was attached. The session transcript remains saved; restart Prime Agent and reopen it from Agents View.",
                                &mut view,
                            );
                            session.exit_reason = "daemon_closed";
                        }
                        RecoveryKind::Lost => {
                            session.note(
                                "could not reconnect to the daemon within 10 minutes — run `prime-agent attach` to resume.",
                                &mut view,
                            );
                            session.exit_reason = "daemon_reconnect_failed";
                        }
                        RecoveryKind::Update => {
                            session.note(
                                "could not reconnect to the daemon within 10 minutes — the update finished but this window is detached. Run `prime-agent attach` to resume.",
                                &mut view,
                            );
                            session.exit_reason = "update_reconnect_failed";
                        }
                    }
                    reconnect = None;
                    session.dirty = true;
                    running = false;
                    continue;
                }
                // The connect leg (bounded connect + hello) runs OFF the
                // loop — the select keeps polling UI input and rendering
                // while it is out; the reattach leg runs inline under its
                // own bound when it lands.
                let socket_path = options.socket_path.clone();
                let (attempt_tx, attempt_rx) = tokio::sync::oneshot::channel();
                reconnect_connect = Some(attempt_rx);
                reconnect_attempt_in_flight = true;
                // TS #2458: the shutdown recovery's discovery waits no
                // longer than the bound — one bounded connect+hello per
                // poll (the fixed 100ms cadence re-arms faster than the
                // retry helper's own backoff, and a single leg bounds the
                // window's over-run; the resume/hiccup windows keep the
                // retrying helper).
                let shutdown = matches!(kind, RecoveryKind::Shutdown);
                tokio::spawn(async move {
                    // No outer timeout: dropping the future mid-attempt
                    // would cancel an in-flight handshake without its
                    // reader abort running (a leaked reader and socket on
                    // an accepting-but-silent daemon). The leg self-bounds
                    // — every attempt's connect and hello carry their own
                    // budgets and abort their own reader on failure.
                    let attempt = if shutdown {
                        DaemonClient::connect(&socket_path).await
                    } else {
                        DaemonClient::connect_with_retry(&socket_path).await
                    };
                    let _ = attempt_tx.send(attempt);
                });
            }
            maybe_attempt = async {
                match reconnect_connect.as_mut() {
                    Some(receiver) => receiver.await,
                    // Nothing in flight: park the arm — the type is
                    // inferred from the in-flight arm, and the tick is the
                    // only spawner (a plain `None` return would hot-spin).
                    None => std::future::pending().await,
                }
            } => {
                reconnect_connect = None;
                reconnect_attempt_in_flight = false;
                // The deadline check runs here too: the tick arm parks
                // while an attempt is in flight, so the window can never
                // overrun its advertised bound by more than the in-flight
                // attempt's connect leg — the expiry note fires as soon as
                // the leg reports back.
                let expired = match reconnect.as_ref() {
                    Some(state) => tokio::time::Instant::now() > state.deadline,
                    None => continue,
                };
                let kind = match reconnect.as_ref() {
                    Some(state) => state.kind,
                    None => continue,
                };
                if expired {
                    match kind {
                        RecoveryKind::Shutdown => {
                            // TS #2458: the daemon never came back within
                            // the reconnect timeout — the saved-transcript
                            // close (the session file survives on disk).
                            session.note(
                                "The Prime Agent daemon shut down while this window was attached. The session transcript remains saved; restart Prime Agent and reopen it from Agents View.",
                                &mut view,
                            );
                            session.exit_reason = "daemon_closed";
                        }
                        RecoveryKind::Lost => {
                            session.note(
                                "could not reconnect to the daemon within 10 minutes — run `prime-agent attach` to resume.",
                                &mut view,
                            );
                            session.exit_reason = "daemon_reconnect_failed";
                        }
                        RecoveryKind::Update => {
                            session.note(
                                "could not reconnect to the daemon within 10 minutes — the update finished but this window is detached. Run `prime-agent attach` to resume.",
                                &mut view,
                            );
                            session.exit_reason = "update_reconnect_failed";
                        }
                    }
                    reconnect = None;
                    session.dirty = true;
                    running = false;
                    continue;
                }
                match maybe_attempt {
                    Ok(Ok((client, fresh_events))) => {
                        // The reattach self-bounds (its budget is inside
                        // the function, so a timeout cannot cancel the
                        // failure-path client close); the budget's expiry
                        // is a RETRY outcome, never a fatal one (§10.4: a
                        // queued attach can legitimately wait out a slow
                        // restore).
                        match session.reattach_after_recovery(client, &mut view, kind).await {
                            Ok(crate::session_ui::ReattachOutcome::Attached) => {
                                events = fresh_events;
                                events_closed = false;
                                reader_dead = session.client.reader_dead();
                                // The fresh connection owes nothing to the
                                // old one's loss states: a retained
                                // supervisor-loss flag or a session-plane
                                // retry left over from before the reconnect
                                // must not fire on the new link.
                                supervisor_lost = false;
                                session_reconnect = None;
                                // Re-arm the loss watch for the fresh
                                // connection: the new client's supervisor
                                // reader can die later, and the one-shot
                                // latch must not park that loss.
                                reader_loss_handled = false;
                                session.reconnect = None;
                                reconnect = None;
                                session.dirty = true;
                            }
                            Ok(crate::session_ui::ReattachOutcome::AttachBudgetExceeded) => {
                                // The queued attach outlived the attempt's
                                // budget (a slow restore): schedule another
                                // on both paths (§10.4 — never a fatal
                                // exit).
                                session.note(
                                    "the daemon is still restoring — retrying…",
                                    &mut view,
                                );
                                session.dirty = true;
                                if let Some(state) = reconnect.take() {
                                    reconnect = Some(state.next_attempt());
                                }
                            }
                            Err(error) => {
                                // An unexpected-loss reattach failure is a
                                // hiccup like any other (the worker still
                                // respawning), and a shutdown recovery
                                // retries until its own bound lands the
                                // saved-transcript close (TS #2458): keep
                                // retrying through the window instead of
                                // exiting — the pane never dies to it (the
                                // operator's kicked-out class). The update
                                // path keeps its exit semantics.
                                if matches!(kind, RecoveryKind::Lost | RecoveryKind::Shutdown) {
                                    session.note_as(
                                        &format!("reattach failed: {error:#} — retrying…"),
                                        crate::chat::StatusKind::Warning,
                                        &mut view,
                                    );
                                    session.dirty = true;
                                    if let Some(state) = reconnect.take() {
                                        reconnect = Some(state.next_attempt());
                                    }
                                } else {
                                    session.note(
                                        &format!("reattach after the update failed: {error:#} — run `prime-agent attach` to resume"),
                                        &mut view,
                                    );
                                    session.exit_reason = "update_reattach_failed";
                                    session.dirty = true;
                                    running = false;
                                }
                            }
                        }
                    }
                    Ok(Err(_)) => {
                        if let Some(state) = reconnect.take() {
                            reconnect = Some(state.next_attempt());
                        }
                    }
                    Err(_) => {
                        // The attempt leg was dropped (a superseded
                        // attempt): the next tick re-arms.
                    }
                }
            }
            _session_reconnect_tick = async {
                match session_reconnect.as_ref() {
                    Some(state) => tokio::time::sleep_until(state.next_attempt).await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                let Some(state) = session_reconnect.take() else {
                    continue;
                };
                // The user switched sessions while the link was down: the
                // new attach owns its own connection, so this driver stops.
                if state.active_session_id != session.active_session_id {
                    continue;
                }
                // The reconnect attempt's budget covers the attach
                // alone: the surface is already up and its dock holds
                // (the background refreshes update it), so the
                // first-frame fold's bounded fetches cannot eat the 10s
                // attempt budget on a slow daemon.
                let attempt = tokio::time::timeout(
                    Duration::from_secs(SESSION_RECONNECT_ATTEMPT_TIMEOUT_S),
                    session.attach_session(
                        &state.active_session_id,
                        crate::session_ui::DockFold::Held,
                    ),
                )
                .await;
                match attempt {
                    Ok(Ok(())) => {
                        // The resynced transcript replaces the chat (TS
                        // `session_resynced`), then the reconnected status
                        // lands on the rebuilt chat (TS
                        // `connection_status: "connected"`).
                        session.rebuild_view(
                            &mut view,
                            &crate::session_ui::RebuildKind::Resync,
                        );
                        session.note_as(
                            "Daemon reconnected",
                            crate::chat::StatusKind::Info,
                            &mut view,
                        );
                        session.reconnection_failed = None;
                        session_reconnect = None;
                        // TS refreshes the heartbeat catalog on the
                        // `connection_status: "connected"` event.
                        session.spawn_heartbeat_refresh();
                        session.dirty = true;
                    }
                    Ok(Err(error)) => {
                        let mut state = state;
                        state.last_error = format!("{error:#}");
                        if tokio::time::Instant::now() > state.deadline {
                            // TS terminal close: the window expired, the
                            // last error surfaces as the closed event's
                            // error row, and the UI stays mounted without
                            // dispatching anything.
                            let failure =
                                format!("Daemon reconnection failed: {}", state.last_error);
                            session.error_row(&failure, &mut view);
                            session.reconnection_failed = Some(state.last_error.clone());
                            session_reconnect = None;
                            session.dirty = true;
                        } else {
                            session_reconnect = Some(state.next_attempt());
                        }
                    }
                    Err(_) => {
                        let mut state = state;
                        state.last_error =
                            "the session re-attach attempt timed out".to_string();
                        if tokio::time::Instant::now() > state.deadline {
                            let failure =
                                format!("Daemon reconnection failed: {}", state.last_error);
                            session.error_row(&failure, &mut view);
                            session.reconnection_failed = Some(state.last_error.clone());
                            session_reconnect = None;
                            session.dirty = true;
                        } else {
                            session_reconnect = Some(state.next_attempt());
                        }
                    }
                }
            }
            () = async {
                // The quiet tick runs only while work is actually
                // pending: a parked editor autocomplete request (TS
                // resolves suggestions asynchronously after the
                // keystroke batch, so a typed command plus Enter in one
                // burst submits as typed and the dropdown opens only
                // once typing pauses) or an armed selection auto-scroll
                // (TS's 150 ms hold + 50 ms interval timer, armed only
                // while a drag holds the window edge). An idle surface
                // parks this arm — TS keeps no free-running timer either
                // (the loader's interval runs only while a turn
                // animates, scheduleRender arms only on a render
                // request), so the unconditional tick spent its wakeups
                // on nothing observable.
                if !(autocomplete_pending || auto_scroll_armed || settle_recheck_wanted) {
                    std::future::pending::<()>().await;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            } => {
                session.materialize_editor_autocomplete(&mut view);
                session.selection_auto_scroll_tick(&mut view);
            }
            () = async {
                // The 2s bash-activity poll, on its own absolute
                // deadline and only on daemons that advertise the
                // kernel-bash registry (the same gate the spawn applies —
                // without the capability every fire was a no-op, so the
                // arm parks and an idle surface spends no wakeups on it).
                if !bash_refresh_wanted {
                    std::future::pending::<()>().await;
                }
                tokio::time::sleep_until(
                    tokio::time::Instant::from_std(last_bash_refresh + Duration::from_secs(2)),
                )
                .await;
            } => {
                last_bash_refresh = Instant::now();
                session.spawn_bash_activity_refresh();
            }
            _frame = async {
                match render_deadline {
                    Some(deadline) => {
                        tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
                    }
                    None => std::future::pending::<()>().await,
                }
            } => {
                // The coalesced frame's deadline arrived: the render gate
                // below paints the accumulated state now.
            }
        }

        // The tray goal label follows the live goal state (TS
        // `syncGoalTray`); the label only changes when the state does.
        session.sync_goal_tray(&mut view);

        // Spinner animation (TS `Loader`'s `setInterval(80ms)` drives the
        // phase, not the render rate): the frame gate below caps renders,
        // so a per-iteration increment would spin the loader too fast —
        // the phase follows the animating clock instead, and only a phase
        // change dirties the frame (TS's interval callback is the only
        // requestRender a quiet turn produces, so a turn without stream
        // events paints at the 80ms loader cadence, not the 16ms frame
        // cap).
        let animating = session.turn_active
            || view.retry.is_some()
            || view.compaction.is_some()
            || view.share_loader.is_some();
        if animating {
            let started = *anim_started.get_or_insert_with(Instant::now);
            let phase = (started.elapsed().as_millis() / SPINNER_INTERVAL_MS) as usize;
            view.pulse_frame = phase;
            if phase != last_pulse_phase {
                session.dirty = true;
            }
            // Arm the next phase boundary: without a deadline the select
            // would only wake on the 50ms tick, adding up to a full tick
            // of spinner latency to every phase change.
            let next_phase =
                started + Duration::from_millis(SPINNER_INTERVAL_MS as u64 * (phase as u64 + 1));
            if render_deadline.is_none_or(|deadline| deadline > next_phase) {
                render_deadline = Some(next_phase);
            }
        } else {
            anim_started = None;
            last_pulse_phase = usize::MAX;
        }

        // The Ctrl+C exit hint expires on a timer (TS
        // `showCtrlCExitHint`'s setTimeout requestRender): once the
        // window passed, the hint row repaints away. The expiry's
        // wake arm lives in the pre-select inventory (see the frame-wake
        // comment there): the wake fires at the expiry, this check marks
        // the row dirty, and the same iteration's frame gate repaints
        // it away.
        if session.ctrl_c_hint_expiry().is_some() {
            hint_painted = true;
        } else if hint_painted {
            session.dirty = true;
            hint_painted = false;
        }

        // The action toasts auto-dismiss on their TTL: once one goes, the
        // overlay repaints away (the same tick-driven repaint the exit
        // hint's expiry uses).
        if view.toasts.prune_expired(Instant::now()) {
            session.dirty = true;
        }

        // The tray override row (the Ctrl+C exit hint, or the streaming
        // follow-up hint over a draft) follows the session's hint state on
        // every frame. Refreshed here — after the select, right before
        // the paint — because a loop-top refresh goes stale across the
        // select's sleep: the expiry-deadline wake would repaint the hint
        // with the pre-sleep value and the corrected tray would never get
        // another paint.
        view.chrome.tray_override = session.tray_override(&view);

        // The frame gate (TS `scheduleRender`: at most one render per
        // MIN_RENDER_INTERVAL_MS): every state change inside the window
        // coalesces into the next frame — a stream burst renders at most
        // one frame per tick instead of one full-transcript layout per
        // event, an idle session re-renders nothing, and a dirty state
        // inside the window waits for the deadline arm above instead of
        // burning a render now.
        if session.dirty {
            if let Some(renderer) = renderer.is_terminal_mut() {
                let interval_elapsed =
                    last_render_at.is_none_or(|at| at.elapsed() >= MIN_RENDER_INTERVAL);
                if interval_elapsed {
                    crate::app::draw(renderer, &mut view)?;
                    session.dirty = false;
                    last_render_at = Some(Instant::now());
                    last_pulse_phase = view.pulse_frame;
                    render_deadline = None;
                    // The attach fold arms this once: the first frame
                    // that renders the rebuilt transcript materializes
                    // its visible window (the wrap/render churn on top
                    // of the fold's parse churn), so return that freed
                    // heap right after the frame paints instead of
                    // keeping the resume's peak resident for the
                    // process lifetime.
                    if session.take_trim_after_frame() {
                        pa_types::memory_release::trim_freed_heap();
                    }
                } else {
                    render_deadline = Some(last_render_at.unwrap() + MIN_RENDER_INTERVAL);
                }
            } else {
                // Headless capture keeps the per-change frame sequence
                // the verifiers assert on: no wall-clock interval applies.
                renderer.render_headless(&mut session, &mut view);
                session.dirty = false;
                last_pulse_phase = view.pulse_frame;
            }
        } else if render_deadline.is_some_and(|deadline| deadline <= Instant::now()) {
            // A fired deadline with nothing dirty to paint must not
            // re-fire on every iteration (the sleep is in the past, so
            // the arm would return immediately): drop it. A future arm
            // (the spinner's next phase boundary) stays: the select needs
            // that wakeup even when nothing else is dirty.
            render_deadline = None;
        }
        if session.exit_requested {
            session.exit_reason = "session_request";
            running = false;
        }
    }

    // The run decided to leave: arm the force-quit deadline so every
    // cleanup step below is best-effort (stats fetch, detach, telemetry,
    // the exit flush). A wedged shutdown path cannot hold the process
    // open past it; the healthy path always finishes well inside.
    // A handoff (agents-back, a `/resume` selection) is a view switch,
    // not an exit: the process keeps running, and TS `returnToAgentsView`
    // has no exit deadline — its `teardownSessionUi` drain may take its
    // full second while the app simply waits. Arming here turned a busy
    // box's slow switch into a mid-teardown process kill ("shutdown
    // stalled; forced exit.", the live report), so the deadline covers
    // only the leaves that end this process.
    let handing_off = session.open_agents_view || session.pending_selection.is_some();
    if renderer.is_terminal() && !handing_off {
        exit_guard.arm_for_exit();
    }
    // TS `returnToAgentsView` -> `stashDraftForAgentsView` + the
    // `teardownSessionUi` release: a handoff to the agents view (or a
    // `/resume <selector>` chain — this build's switch surfaces) stashes
    // the live draft for the session being left; every exit releases the
    // run's binding (a held draft stays in the store for the next view).
    if session.open_agents_view || session.pending_selection.is_some() {
        session.stash_draft_for_agents_view(&view);
        // The cross-view layout handoff (view::handoff): hold the last
        // frame's visible-window packs keyed by the LATEST event sequence
        // this run has seen (the live tracker), so the unchanged-session
        // re-entry's first draw reuses them instead of re-rendering the
        // window — including the post-turn sojourn class, where a turn
        // during this run advanced the worker's sequence past this run's
        // own attach value: the stash keys the value the NEXT attach
        // reports when the sojourn itself stayed transcript-unchanged
        // (every changed attach still misses and re-renders exactly as
        // before). A cursor-less attach never keys (the collapsed
        // default identity could alias across same-count attaches).
        if session.attach_cursor_present {
            view.stash_layout_handoff(
                &session.session_id,
                &session.attach_event_generation,
                session.last_event_sequence,
            );
        }
    }
    session.release_prompt_stash_session();
    // TS `shutdown` fetches the session stats while the connection is
    // alive, then prints the resume hint after teardown; pa-cli prints it
    // once the terminal is restored. Bounded best-effort. The agents-view
    // handoff never prints it (TS `returnToAgentsView` skips the stats
    // fetch entirely — the next surface is another view, not a process
    // exit), so the round-trip is dead work on that path.
    let resume_hint = if session.open_agents_view {
        None
    } else {
        session.exit_resume_hint().await
    };
    // Detach explicitly so the session's attached-client count stays honest;
    // the supervisor also detaches this connection when the socket closes.
    // Bounded hard: a wedged worker socket can never hold the exit path.
    // The agents-view handoff fires the detach in the background instead
    // (attached-client bookkeeping must not delay the switch; the request
    // is on the wire before the handoff returns, and the background task
    // owns this connection until the daemon answers or the cap fires).
    if session.open_agents_view {
        session.detach_for_handoff();
    } else {
        session.detach_for_exit().await;
    }
    // `tui exit` (schema v1): how the run ended. Bounded the same way as
    // the detach — telemetry must never hold the exit path open either.
    // The handoff still emits the event but does not wait for the flush:
    // the agents view keeps the process (and the runtime) alive, so the
    // background flush completes while the user is already in the view
    // (TS hands the pane to the next mode without any teardown await).
    let exit_reason = session.exit_reason();
    let turn_active_at_exit = session.turn_active;
    if let Some(telemetry) = session.telemetry.clone() {
        let exit_event = async move {
            let () = telemetry
                .client_exit(exit_reason, turn_active_at_exit)
                .await;
        };
        if session.open_agents_view {
            tokio::spawn(exit_event);
        } else {
            let _ =
                tokio::time::timeout(Duration::from_millis(TELEMETRY_EXIT_TIMEOUT_MS), exit_event)
                    .await;
        }
    }
    // Agents-back and `/resume` hand the pane to the agents view; the
    // alternate screen stays in place for it instead of flushing to the
    // main screen (TS `stop({ preserveAltScreen: true })`).
    let preserve_alt_screen = session.open_agents_view;
    let outcome = InteractiveOutcome {
        active_session_id: session.active_session_id.clone(),
        session_id: session.session_id.clone(),
        resume_hint,
        last_assistant_text: session.last_assistant_text.clone(),
        frames: renderer.finish(&mut view, preserve_alt_screen),
        // The headless OSC 52 capture (terminal runs wrote the sequences
        // to stdout as they happened).
        clipboard_emissions: session.take_osc_emissions(),
        return_to_agents_view: preserve_alt_screen,
        agents_view_scope: session.scoped_agents_view.take(),
        selection_request: session.pending_selection,
        copies: std::mem::take(&mut session.copies),
        opened_urls: std::mem::take(&mut session.opened_urls),
        // TS #2391: the view's status line keeps the wait notice when the
        // chat hands back (the `updateRestartWaitNotice` the open armed).
        agents_view_notice: if waited_for_update_restart && preserve_alt_screen {
            Some(crate::update_restart_wait::DAEMON_UPDATE_RESTART_WAIT_NOTICE.to_string())
        } else {
            None
        },
        handoff_seeds: view.handoff_seeds,
    };
    // The agents-view handoff's background detach owns this connection now
    // (it closes once the daemon answers); every other exit closes it here.
    if !preserve_alt_screen {
        session.client.close();
    }
    // A handoff (agents view, `/resume <selector>`) lets the process keep
    // running: retire the watchdog. Every other completion is a process
    // exit, where the deadline dies with the process — or fires when the
    // exit wedged, which is the point.
    if outcome.return_to_agents_view || outcome.selection_request.is_some() {
        exit_guard.cancel();
    }
    Ok(outcome)
}
