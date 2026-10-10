//! The interactive run's entry points and open routes, the terminal/headless surface loop with the
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

/// Headless-only bound on the exit gate after [`UiInput::HeadlessDone`]: a settle member that never
/// drains would otherwise park the run forever; green settles take milliseconds.
const HEADLESS_SETTLE_TIMEOUT_MS: u64 = 60_000;

const MIN_RENDER_INTERVAL: Duration = Duration::from_millis(16);
/// The spinner's wall-clock cadence, not the render rate.
const SPINNER_INTERVAL_MS: u128 = 80;
/// The input-idle window the quiet tick waits out before materializing parked work.
const QUIET_TICK_INTERVAL: Duration = Duration::from_millis(50);

/// The animating loader's next phase boundary, the wake the select needs
/// while a quiet turn waits out its stream: TS `Loader`'s `setInterval`
/// keeps painting the 80ms cadence through quiet turns, and this
/// boundary is that interval's timer. The wake always precedes the
/// phase change it observes — an off-by-one here parks the loop for a
/// whole boundary instead of firing at the phase edge.
fn next_spinner_deadline(started: Instant, now: Instant) -> Instant {
    // The remainder form keeps the arithmetic bounded by one phase: a
    // wide phase counter would truncate through `as usize` on 32-bit
    // targets after ~10.9 years of continuous animation and arm an
    // already-expired deadline, hot-spinning the select's wake.
    let into_phase = now.duration_since(started).as_millis() % SPINNER_INTERVAL_MS;
    now + Duration::from_millis((SPINNER_INTERVAL_MS - into_phase) as u64)
}

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
    /// The CLI's open (`prime-agent`, `--resume`, `--attach`): a single attempt.
    Cli,
    /// The agents view's open: waits through the update-restart window and retries.
    AgentsView,
}

/// Run one interactive session (the CLI open route).
///
/// # Errors
///
/// Returns `Err` when the interactive surface fails; the restore runs first whenever this run owned
/// or adopted the terminal.
pub async fn run_interactive(
    options: InteractiveOptions,
    ui: UiMode,
) -> Result<InteractiveOutcome> {
    run_interactive_route(options, ui, SessionOpenRoute::Cli).await
}

/// Run one interactive session opened from the agents view (see
/// [`SessionOpenRoute::AgentsView`]).
///
/// # Errors
///
/// Returns `Err` when the interactive surface fails or the open waits out the update-restart
/// window; the restore runs first whenever this run owned or adopted the terminal.
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
    // The headless harness never owned the terminal, so its error returns must not run a restore.
    let owns_terminal = matches!(ui, UiMode::Terminal);
    // A terminal-mode error that fired BEFORE this surface mounted must not tear down whatever the
    // CALLER had up.
    let surface_mounted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mounted = std::sync::Arc::clone(&surface_mounted);
    match run_interactive_surface(options, ui, route, mounted).await {
        Ok(outcome) => Ok(outcome),
        Err(error) => {
            // The adopting surface owns the release even when it fails before mounting; a
            // fresh-pane pre-mount failure has nothing to release.
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

/// The `SubmitAndSettle` barrier's daemon round trip: submit the message
/// as a `prompt_and_wait`, then read the session's event sequence through
/// `get_rlm_children` — the one read-only command that reports it. Both
/// requests are bounded by `timeout_ms`.
async fn settled_sequence(
    client: &DaemonClient,
    active_session_id: String,
    message: String,
    timeout_ms: u64,
) -> anyhow::Result<u64> {
    let input = pa_types::daemon::PromptInput {
        content: None,
        images: None,
        streaming_behavior: Some(pa_types::daemon::StreamingBehavior::Steer),
        queue_if_busy: Some(true),
        expand_prompt_templates: None,
        source: None,
        agent_message_id: None,
        custom_message: None,
        queue_key: None,
        prefix_messages: None,
        admission_id: None,
        rlm_notice_nonce: None,
    };
    let waited = client
        .request_with_timeout(
            pa_types::daemon::DaemonCommand::PromptAndWait {
                id: None,
                active_session_id: active_session_id.clone(),
                message,
                input,
                rest: serde_json::Map::default(),
            },
            timeout_ms,
        )
        .await?;
    anyhow::ensure!(waited.success, "prompt_and_wait failed: {:?}", waited.error);
    let children = client
        .request_with_timeout(
            pa_types::daemon::DaemonCommand::GetRlmChildren {
                id: None,
                active_session_id,
                rest: serde_json::Map::default(),
            },
            timeout_ms,
        )
        .await?;
    children
        .data
        .as_ref()
        .and_then(|data| data.get("eventSequence"))
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| anyhow::anyhow!("get_rlm_children carried no eventSequence"))
}

async fn run_interactive_surface(
    options: InteractiveOptions,
    ui: UiMode,
    route: SessionOpenRoute,
    surface_mounted: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<InteractiveOutcome> {
    // The TS theme emits raw ANSI color codes regardless of NO_COLOR; match that.
    crossterm::style::force_color_output(true);
    // The first open attempt uses this connection (a fresh-pane connect failure must stay a
    // pre-mount failure); a wait retry reconnects against the successor daemon.
    let (client, events) = DaemonClient::connect_with_retry(&options.socket_path)
        .await
        .with_context(|| "the interactive UI could not attach to the daemon")?;
    let (notes_tx, mut notes_rx) = mpsc::unbounded_channel::<String>();
    let (compaction_abort_tx, mut compaction_abort_rx) =
        mpsc::unbounded_channel::<crate::session_ui::CompactionAbortNote>();
    let (prompt_tx, mut prompt_rx) =
        mpsc::unbounded_channel::<crate::session_ui::PromptSubmitNote>();
    let (share_tx, mut share_rx) = mpsc::unbounded_channel::<crate::session_ui::ShareNote>();
    let (update_tx, mut update_rx) = mpsc::unbounded_channel::<crate::session_ui::UpdateNote>();
    let (reload_tx, mut reload_rx) = mpsc::unbounded_channel::<crate::session_ui::ReloadNote>();
    let (traces_upload_tx, mut traces_upload_rx) =
        mpsc::unbounded_channel::<crate::session_ui::TracesUploadNote>();
    let (catalog_tx, mut catalog_rx) =
        mpsc::unbounded_channel::<crate::session_ui::ModelCatalogUpdate>();
    let (heartbeats_tx, mut heartbeats_rx) =
        mpsc::unbounded_channel::<crate::session_ui::HeartbeatsUpdate>();
    let (auth_panel_tx, mut auth_panel_rx) =
        mpsc::unbounded_channel::<crate::auth_panel::AuthPanelRequest>();
    let (bash_tx, mut bash_rx) = mpsc::unbounded_channel::<crate::session_ui::BashActivityUpdate>();
    // Background factory refreshes (the factory page's watch+graph
    // cadence and the dock count's poll) report here; the loop folds them
    // into the session — the open page's panels and the dock's count.
    let (factory_tx, mut factory_rx) =
        mpsc::unbounded_channel::<crate::session_ui::FactoryUpdate>();
    // Background slash-command-catalog refreshes (`get_commands`) report
    // here; the loop folds the session's skill commands into the
    // autocomplete provider.
    let (commands_tx, mut commands_rx) =
        mpsc::unbounded_channel::<crate::session_ui::CommandCatalogUpdate>();
    // The double-Ctrl+C force-quit guard: the terminal reader observes the pair while this loop is
    // wedged in a daemon request; a std-thread watchdog enforces the exit deadline without the
    // runtime.
    let exit_guard = ExitGuard::new();

    // The view and the terminal surface come up BEFORE the session attach: the pane paints the
    // startup chrome immediately, and the transcript renders when the snapshot lands.
    let theme = crate::app::load_theme(&options.theme);
    let mut view = AgentView::new(theme);
    view.code_block_indent = options.code_block_indent.clone();
    // The file-completion provider browses the SESSION cwd, not the process cwd: the completion
    // menu must browse the directory the user sees.
    view.editor.set_autocomplete_provider(Box::new(
        crate::autocomplete::CombinedAutocompleteProvider::from_registry(options.cwd.clone()),
    ));
    view.editor.set_keybindings(options.keybindings.clone());
    view.show_images = options.show_images;
    if let Some(settings) = &options.client_settings {
        view.show_hardware_cursor = settings.show_hardware_cursor();
        // A chat opens at the persisted `chatDetail` level; an unset store reads as the collapsed
        // `overview` startup level (operator directive 2026-09-28).
        view.detail = crate::chat::Detail::from_wire_name(&settings.chat_detail());
    }
    apply_startup_chrome(&mut view, &options);
    let (ui_tx, mut ui_rx) = mpsc::unbounded_channel::<UiInput>();
    // Headless verification runs capture the OSC 52 clipboard channel instead of the plain pipes.
    let headless = matches!(ui, UiMode::Headless(_));
    // A panic between the mount below and the deliberate teardown must still hand the terminal
    // back whole: the unwind guard fires the one exit restore (a set_hook cannot — tokio catches
    // task panics).
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
    //
    // The same predicate names the surface the opening phase below may
    // repaint: a NEW chat's chrome already mounted (its echo frames
    // paint at the frame scheduler's cadence), while a held surface
    // (a direct open into an existing session) and headless capture
    // runs never paint during the open — the first draw stays the
    // open's content frame.
    let opening_paints = !headless
        && matches!(
            &options.session,
            SessionSelection::New | SessionSelection::NewChild { .. }
        );
    if opening_paints {
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
    //
    // The open runs as a BACKGROUND task: the opening phase below serves
    // keystrokes while it completes. TS `init()` runs `ui.start()` (the
    // input surface is live) and awaits `rebindCurrentSession()` on an
    // already-serving event loop; the port's old shape ran the whole open
    // pipeline before the run loop took its first input, so time-to-type
    // waited on the create, the attach, the dock folds, and every daemon
    // readiness behind them (the operator's input-latency report: first
    // frame 40-52ms, keystroke echo ~250ms later warm, ~0.6-1.6s cold).
    let mut first_connection = Some((client, events));
    let mut open_task = {
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
        let factory_tx = factory_tx.clone();
        let commands_tx = commands_tx.clone();
        let waits_through_update_restart = route == SessionOpenRoute::AgentsView;
        tokio::spawn(async move {
            crate::update_restart_wait::wait_through_update_restart(
                waits_through_update_restart,
                crate::update_restart_wait::DAEMON_UPDATE_RESTART_OPEN_WAIT_MS,
                crate::update_restart_wait::DAEMON_UPDATE_RESTART_OPEN_RETRY_MS,
                || {
                    // The attempt future owns everything it touches (an
                    // `async move` over clones taken here): an `FnMut`
                    // closure's captures may not escape into the returned
                    // future, so the synchronous body moves the pieces out
                    // instead.
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
                    let factory_tx = factory_tx.clone();
                    let commands_tx = commands_tx.clone();
                    async move {
                        let (client, events) = match first {
                            Some(first) => first,
                            None => DaemonClient::connect(&options.socket_path)
                                .await
                                .with_context(|| {
                                    "the interactive UI could not attach to the daemon"
                                })?,
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
                                factory: factory_tx,
                                commands: commands_tx,
                            },
                        )
                        .await?;
                        Ok((events, session))
                    }
                },
            )
            .await
        })
    };
    // The opening phase: the input surface serves keystrokes while the
    // open task runs (AGENTS.md "Performance and the critical path": the
    // input box mounts and accepts keystrokes without waiting on
    // daemon/kernel/config readiness that is not user-visible work).
    // Editor-level keys echo into the mounted startup chrome at the frame
    // scheduler's cadence; everything else (submits, commands, overlay
    // keys) queues in `pending` — the same deque the run loop drains —
    // so typed-ahead is delivered, in order, the moment the open lands:
    // never lost, never errored. The open's own result (success or the
    // daemon-refusal arms below) is unchanged; only the WAIT moved off
    // the input path.
    //
    // ORDERING (the contract the headless plans pin): the editor always
    // holds a PREFIX of the user's input stream. The first input that
    // must queue (a submit, an overlay key, a mouse report) parks the
    // echo path for the rest of the phase — every later input queues
    // behind it, so a typed `H` can never land in the editor ahead of a
    // queued `ctrl+home` the user pressed first.
    let mut pending: VecDeque<UiInput> = VecDeque::new();
    // Base parity for the stash restore (finding #3): a session-reopen
    // launch (Resume/Attach — the shape that can carry a stashed draft)
    // never accepts typed-ahead into the editor during the open. The
    // fold's `restore_prompt_stash_on_open` gates on the editor being
    // EMPTY, so echoing into it pre-restore would silently consume the
    // restore (the draft stays stashed while the typed-ahead sits in its
    // place). A reopen's typed-ahead queues instead and dispatches
    // through the editor AFTER the fold's restore — base ordering
    // exactly. A NEW session owns no stash, so its launches keep the
    // echo path (headless new-session plans included: no stash exists to
    // protect).
    let mut echoing = matches!(
        &options.session,
        SessionSelection::New | SessionSelection::NewChild { .. }
    );
    let mut ui_input_closed = false;
    let mut last_render_at: Option<Instant> = None;
    let mut render_deadline: Option<Instant> = None;
    let mut opening_dirty = false;
    // A first-run onboarding task owns the pane BEFORE the chat surface:
    // the phase below consumes `ui_rx` itself once the open lands (it
    // needs the session, so it cannot run during the opening phase). The
    // opening loop must therefore not touch the channel on an onboarding
    // launch — the login/trace dialogs' keystrokes stay queued in the
    // channel for the phase to consume in order, exactly the base
    // ordering for this flow (the editor-level echo service below is the
    // chat chrome's surface, the pane a New chat's open actually mounts).
    let opening_serves_input = options.onboarding.is_none();
    let open_outcome = loop {
        tokio::select! {
            // The open completing is the phase's exit; the failure arms
            // below run against the same error exactly as before.
            open_result = &mut open_task => {
                break match open_result {
                    Ok(outcome) => outcome,
                    Err(join_error) => Err(anyhow::anyhow!(
                        "the session open task failed: {join_error}"
                    )),
                };
            }
            maybe_input = async {
                if ui_input_closed {
                    std::future::pending::<Option<UiInput>>().await
                } else {
                    ui_rx.recv().await
                }
            }, if opening_serves_input => {
                match maybe_input {
                    None => {
                        // The reader side is gone: park the arm instead of
                        // hot-spinning on the instantly-ready closed
                        // channel while the open task still runs.
                        ui_input_closed = true;
                    }
                    Some(input) => match input {
                        UiInput::Key(key) => {
                            if let Some(id) = crate::keys::key_event_to_id(&key) {
                                // `app.exit` on the empty editor (default
                                // ctrl+d) is the one exit that must not
                                // wait out the open: hand the terminal
                                // back now (the open task dies with the
                                // runtime; the daemon-side create, if it
                                // already ran, leaves a resumable session
                                // exactly like an exit right after the
                                // open). A queue already holding input
                                // keeps the exit's ordering instead: the
                                // exit dispatches with the rest.
                                if view
                                    .editor
                                    .keybindings()
                                    .matches(&id, "app.exit")
                                    && view.editor.get_text().is_empty()
                                    && echoing
                                {
                                    exit_guard.arm_for_exit();
                                    renderer.finish(&mut view, false);
                                    return Ok(InteractiveOutcome {
                                        frames: Vec::new(),
                                        ..Default::default()
                                    });
                                }
                                // Pure editor keys echo now (the TS
                                // editor path) while the stream is still a
                                // clean prefix — but only when the
                                // effective keymap leaves the key to the
                                // editor fallback (finding #1): a key the
                                // post-open dispatch would claim for an
                                // app/session action keeps its normal
                                // route, queued behind the open and
                                // dispatched through the full
                                // keymap-aware ladder at the fold, instead
                                // of becoming a stray editor motion (the
                                // misroute: default `left` on the empty
                                // editor is `app.agents.back`, and a
                                // user-bound space or single char runs its
                                // bound action). The first queue parks
                                // the echo path so later keys cannot jump
                                // it.
                                let editor_motion = matches!(
                                    id.as_str(),
                                    "backspace" | "delete" | "left" | "right" | "space"
                                ) || id.chars().count() == 1;
                                if echoing
                                    && editor_motion
                                    && !crate::session_ui::opening_echo_key_claimed(
                                        view.editor.keybindings(),
                                        &id,
                                        &view.editor,
                                    )
                                {
                                    view.editor.handle_input(&id);
                                    opening_dirty = true;
                                } else {
                                    echoing = false;
                                    pending.push_back(UiInput::Key(key));
                                }
                            }
                        }
                        UiInput::Paste(text) => {
                            if echoing {
                                let _ = view.editor.handle_paste(&text);
                                opening_dirty = true;
                            } else {
                                pending.push_back(UiInput::Paste(text));
                            }
                        }
                        UiInput::Resize => {
                            // Geometry is order-insensitive, so the resize
                            // always applies now: the same update the run
                            // loop's resize arm performs, so the editor lays
                            // its window out against the new row count and
                            // the echo frames below paint at the new
                            // geometry instead of the stale one.
                            if let Ok((_width, height)) = crossterm::terminal::size() {
                                view.set_terminal_rows(height);
                            }
                            opening_dirty = true;
                        }
                        other => {
                            echoing = false;
                            pending.push_back(other);
                        }
                    },
                }
                // The echo frame coalesces on the run loop's own
                // MIN_RENDER_INTERVAL: a typing burst paints as one
                // frame, a lone key paints immediately.
                if opening_paints && opening_dirty {
                    let now = Instant::now();
                    if last_render_at
                        .is_none_or(|at| now.duration_since(at) >= MIN_RENDER_INTERVAL)
                    {
                        if let Some(renderer) = renderer.is_terminal_mut() {
                            crate::app::draw(renderer, &mut view)?;
                        }
                        last_render_at = Some(now);
                        opening_dirty = false;
                        render_deadline = None;
                    } else {
                        render_deadline =
                            last_render_at.map(|at| at + MIN_RENDER_INTERVAL);
                    }
                }
            }
            // The coalesced echo frame's deadline (armed only while a
            // dirty frame waits out the render interval).
            () = async {
                match render_deadline {
                    Some(deadline) => {
                        tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
                    }
                    None => std::future::pending::<()>().await,
                }
            }, if render_deadline.is_some() => {
                render_deadline = None;
                if let Some(renderer) = renderer.is_terminal_mut() {
                    crate::app::draw(renderer, &mut view)?;
                }
                last_render_at = Some(Instant::now());
                opening_dirty = false;
            }
        }
    };
    let ((mut events, mut session), waited_for_update_restart) = match open_outcome {
        Ok(opened) => opened,
        Err(error) => {
            // A daemon refusal for the startup create/attach/resume: the pane hands off to the
            // agents view instead of dying to the shell; only transport/protocol failures stay
            // fatal. The unknown-session check matches the daemon's RAW refusal message exactly -
            // it must name this attach's own selector - so a selector containing the phrase could
            // not forge it.
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
                    // The handoff keeps the process alive: disarm the double-Ctrl+C watchdog.
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
            // A response/handshake timeout (the daemon alive but slow at load) is a hiccup, not a
            // protocol failure: the same session-picker fallback, never a fatal exit (operator
            // directive 2026-09-24).
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
            // Any other daemon refusal gets the same session-picker fallback.
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
            // The open wait's deadline failure is the same handoff: the guidance to retry must land
            // on the view the user came from.
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
            // The surface is already up: hand the terminal back before the CLI reports the failure.
            if renderer.is_terminal() {
                exit_guard.arm_for_exit();
            }
            renderer.finish(&mut view, false);
            return Err(error);
        }
    };
    session.exit_guard = exit_guard.clone();
    // The supervisor reader's death watch: the event channel stays open across a supervisor socket
    // loss, so this watch is the signal the reconnect driver arms on. Taken from the LIVE session
    // client after the open (a wait retry may have reconnected).
    let mut reader_dead = session.client.reader_dead();
    if headless {
        session.osc_sink = crate::clipboard::OscSink::Buffer(Vec::new());
    }
    // The tray's context usage came in with the attach snapshot, so the
    // open path does not block on a stats fetch.
    session.spawn_model_catalog_refresh();
    session.rebuild_view(&mut view, &crate::session_ui::RebuildKind::Rebind);
    // The cross-view layout handoff's adopt (view::handoff): a re-entry whose attach cursor exactly
    // matches the previous run's held handoff holds its visible-window packs for the first draw;
    // any chat mutation retires it. A cursor-less re-attach never adopts.
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
    // An open that waited through the update restart says so in the session's first status row.
    if waited_for_update_restart {
        let notice = crate::update_restart_wait::DAEMON_UPDATE_RESTART_WAIT_NOTICE;
        view.push_entry(crate::chat::ChatEntry::Status {
            text: format!("\u{26a0} {notice}"),
            kind: crate::chat::StatusKind::Warning,
        });
        session.dirty = true;
    }
    // The ban-risk warning on an Anthropic subscription credential at startup.
    if let Some(provider) = session.current_model_provider().await {
        session
            .maybe_warn_anthropic_subscription_auth_if_subscribed(
                Some(provider.as_str()),
                &mut view,
            )
            .await;
    }
    // The once-per-installation telemetry disclosure (TS
    // agent-session-services): rendered as an info row here — the alt
    // screen hides any pre-TUI stderr print, so the row is the only
    // shape the user actually sees.
    session.maybe_show_telemetry_notice(&mut view);
    // TS `restorePromptStashOnOpen`: a draft stashed on the way out (a
    // previous chat view of this session left via the agents view or a
    // switch) returns to the editor when its chat reopens.
    session.restore_prompt_stash_on_open(&mut view);
    // Declared above the onboarding phase: the pane's drive marks it.
    let mut headless_done = false;
    // The settle bound's deadline (see [`HEADLESS_SETTLE_TIMEOUT_MS`]).
    let mut headless_settle_deadline: Option<Instant> = None;
    let mut headless_settle_pending = false;
    // First-run onboarding owns the pane before the session screen: a ready home sees the trace
    // question alone, a not-ready home runs the full sign-in flow, and the marker gate keeps it
    // one-shot.
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
            // The exit deadline is armed from the moment the run decides to leave: no cleanup below
            // may block past it.
            exit_guard.arm_for_exit();
            session.detach_for_exit().await;
            // The user quit at the onboarding screen: still hand the terminal back.
            renderer.finish(&mut view, false);
            return Ok(InteractiveOutcome {
                active_session_id: session.active_session_id.clone(),
                session_id: session.session_id.clone(),
                resume_hint: None,
                last_assistant_text: None,
                frames: Vec::new(),
                clipboard_emissions: Vec::new(),
                agents_view_scope: None,
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

    // The fold's first frame must land before the opening phase's
    // typed-ahead queue dispatches: base painted it between the fold and
    // the first input (the select round-trip owns one frame per
    // iteration), and a pre-loaded queue would otherwise starve it — the
    // queued inputs would paint only their own deltas over a state the
    // verifier never saw rendered.
    if !pending.is_empty() && session.dirty {
        if let Some(renderer) = renderer.is_terminal_mut() {
            crate::app::draw(renderer, &mut view)?;
        } else {
            renderer.render_headless(&mut session, &mut view);
        }
        session.dirty = false;
    }

    // `pending` rides in from the opening phase: typed-ahead inputs
    // queued behind the open dispatch first, in order.
    let mut last_bash_refresh = Instant::now();
    let mut last_factory_refresh = Instant::now();
    // The enhanced-key modes settle once (kitty answer or fallback) and
    // report one adoption event; headless runs hold pipes and never probe.
    let mut enhanced_keys_pending = renderer.is_terminal();
    // The hyperlink capability is env-based, settles at run start; terminal runs report it once.
    let mut hyperlinks_pending = renderer.is_terminal();
    // State changes coalesce into at most one frame per MIN_RENDER_INTERVAL_MS; `render_deadline`
    // is armed while a dirty frame waits out the interval.
    let mut last_render_at: Option<Instant> = None;
    let mut render_deadline: Option<Instant> = None;
    let mut quiet_tick_deadline: Option<Instant> = None;
    let mut anim_started: Option<Instant> = None;
    // The spinner phase painted by the last frame (`usize::MAX` before the first): a quiet turn
    // only dirties when the 80ms phase advances.
    let mut last_pulse_phase: usize = usize::MAX;
    // Whether the Ctrl+C exit hint painted a frame that the expiry must clear.
    let mut hint_painted = false;
    let mut running = true;
    let mut wait_idle_deadline: Option<Instant> = None;
    // The headless `SubmitAndSettle` barrier's target and deadline.
    let mut settle_target: Option<(u64, Instant)> = None;
    // The headless render barrier's armed state: its deadline, and the
    // frames captured at arming (the `WaitRender` condition scans only
    // frames rendered after the barrier became the queue's head, so a
    // needle that already scrolled out of an older frame still satisfies
    // it; `WaitGone` checks only the newest frame).
    let mut wait_render_deadline: Option<Instant> = None;
    let mut wait_render_baseline: usize = 0;
    // Spec §10.2: the reconnect loop after a `daemon_closing` update frame. Retry with backoff up
    // to RECONNECT_WINDOW; each attempt reads the successor's hello (§10.3) and reattaches by
    // durable session id (§10.4). UI input keeps flowing while reconnecting.
    let mut reconnect: Option<ReconnectLoop> = None;
    // The in-flight reconnect attempt's connect leg (spawned off the loop, so the connect+hello
    // wait never blocks UI input or the render); the reattach leg runs inline on the loop.
    let mut reconnect_connect: Option<ReconnectConnect> = None;
    // Mirrors `reconnect_connect`'s in-flight state as a plain copy so the tick arm's future can
    // park without borrowing the attempt receiver.
    let mut reconnect_attempt_in_flight = false;
    // The reader-death watch is one-shot: once the loss is handled (or suppressed), the arm parks
    // so the closed watch cannot hot-spin the select loop.
    let mut reader_loss_handled = false;
    // The supervisor connection died while a live direct link kept serving the session: the loss is
    // retained until the direct link itself dies; then the full reconnect driver owns the recovery.
    let mut supervisor_lost = false;
    // Set once the event channel has returned None (see the events arm).
    let mut events_closed = false;
    // The session re-attach driver: armed when the direct worker link dies (a killed or crashed
    // worker); it re-attaches through the supervisor so the respawned worker serves the session
    // again.
    let mut session_reconnect: Option<SessionReconnect> = None;

    'run: while running {
        if enhanced_keys_pending {
            if let Some((kitty, modify_other_keys)) = crate::enhanced_keys::settle_state() {
                if let Some(telemetry) = &session.telemetry {
                    telemetry.enhanced_keys(kitty, modify_other_keys).await;
                }
                enhanced_keys_pending = false;
            }
        }

        // The OSC 8 hyperlink capability settles once per run: one adoption event reports the gate.
        // The flush shutdown can wait out a slow endpoint, so the event is spawned instead of
        // awaited.
        if hyperlinks_pending {
            if let Some(telemetry) = session.telemetry.clone() {
                let enabled = crate::hyperlinks::hyperlinks_enabled();
                tokio::spawn(async move {
                    telemetry.hyperlinks_active(enabled).await;
                });
            }
            hyperlinks_pending = false;
        }

        // Drain the whole queued input batch in this one iteration (TS dispatches every event of
        // a stdin chunk): a burst applies as one batch instead of one render pass per event. A
        // WaitIdle step is a barrier: it holds at the queue head until the turn finishes.
        let mut inputs_pending = !pending.is_empty();
        while inputs_pending {
            if let Some(UiInput::WaitIdle { timeout_ms }) = pending.front() {
                let timeout_ms = *timeout_ms;
                // A parked follow-up/steering message keeps the barrier waiting until the session
                // delivers it; a submit whose round trip is still armed holds the barrier too
                // (the async submit resolves off the render path).
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
                    inputs_pending = false;
                } else {
                    wait_idle_deadline = None;
                    pending.pop_front();
                }
            } else if let Some((text, timeout_ms)) = match pending.front() {
                Some(UiInput::SubmitAndSettle { text, timeout_ms }) => {
                    Some((text.clone(), *timeout_ms))
                }
                _ => None,
            } {
                // The supervisor races its response and event queues in
                // one select, so the response arriving proves nothing:
                // hold until this run has processed the settled sequence.
                let Some((settled, deadline)) = settle_target else {
                    match settled_sequence(
                        &session.client,
                        session.active_session_id.clone(),
                        text,
                        timeout_ms,
                    )
                    .await
                    {
                        Ok(settled) => {
                            settle_target =
                                Some((settled, Instant::now() + Duration::from_millis(timeout_ms)));
                        }
                        Err(error) => {
                            session.note(&format!("settle barrier failed: {error:#}"), &mut view);
                            pending.pop_front();
                        }
                    }
                    continue;
                };
                if session.last_event_sequence >= settled {
                    settle_target = None;
                    pending.pop_front();
                } else if Instant::now() > deadline {
                    session.note("timed out waiting for the turn to settle", &mut view);
                    settle_target = None;
                    pending.pop_front();
                } else {
                    inputs_pending = false;
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
                // The render barrier: `WaitRender` holds until a frame rendered after arming
                // contains the needle; `WaitGone` holds until the newest frame cleared it (the
                // baseline is recorded at arming). The timeout note never embeds the needle:
                // quoting it would make a timed-out wait satisfy the very condition that failed.
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
                        inputs_pending = false;
                    }
                }
            } else if let Some(input) = pending.pop_front() {
                // Timing markers observe the previous frame without dirtying the view or
                // adding a select/render iteration to the measured input sequence. The render
                // count rides along: the frame capture dedupes on plain text, so restyle-only
                // renders need a separate witness.
                if let UiInput::Timestamp(sender) = input {
                    sender.send((Instant::now(), renderer.headless_renders()))?;
                    continue;
                }
                session.dirty = true;
                match input {
                    UiInput::Key(key) => {
                        session.stop_selection_auto_scroll();
                        match session.handle_key(key, &mut view, &mut running).await {
                            Ok(()) => {}
                            // A daemon refusal or a connection failure on this key's request
                            // surfaces an error row and keeps the loop running with the editor
                            // state preserved — a failed request never exits the client.
                            Err(error)
                                if crate::daemon_client::is_daemon_rejection(&error)
                                    || crate::daemon_client::is_daemon_unreachable(&error) =>
                            {
                                session.error_row(&format!("{error:#}"), &mut view);
                            }
                            // Everything else (protocol corruption) stays fatal.
                            Err(error) => return Err(error),
                        }
                        // Hand the terminal to the shell and stop the process group; execution
                        // continues here once the user foregrounds the process, where the cycle
                        // re-applies raw mode, the alt screen, and SGR mouse tracking. Headless
                        // runs keep no terminal renderer, so the request is observed and dropped.
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
                                    // Try to take the terminal back so the run stays usable; if
                                    // that also fails, the draw below surfaces the broken frame.
                                    let _ = renderer.resume();
                                }
                            }
                        }
                        // Hand the terminal to the editor, then resume. The input reader would
                        // steal the editor's keys, so it stops (flag + join) and respawns after the
                        // resume.
                        if let Some(command) = session.take_external_editor_request() {
                            let reader = match &renderer {
                                Renderer::Terminal {
                                    ui_tx, exit_guard, ..
                                } => Some((ui_tx.clone(), exit_guard.clone())),
                                Renderer::Headless { .. } => None,
                            };
                            if let Some((ui_tx, exit_guard)) = reader {
                                crate::input::stop_reader();
                                // The suspend path's SIGINT shield: the handoff restores cooked
                                // mode (ISIG), and a cooked-mode editor wrapper (`code --wait`,
                                // `subl -w`) turns Ctrl+C into SIGINT for the shared foreground
                                // group — the default disposition would kill the TUI mid-edit. The
                                // no-op handler (never SIG_IGN) keeps the child's own Ctrl+C
                                // (handled signals reset across exec).
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
                                // SIGINT is back to default before the surface takes over.
                                if crate::suspend::supported() {
                                    use crate::suspend::SuspendSignals;
                                    let _ = signals.restore_sigint();
                                }
                                // The surface returns even when the editor run failed.
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
                        // The `/mcp` view resolved to an auth request: mount the inline auth panel
                        // and spawn the client auth command — no flow touches the terminal.
                        if session.pending_mcp_auth() {
                            session.run_mcp_auth(&mut view);
                        }
                    }
                    UiInput::Paste(text) => {
                        session.stop_selection_auto_scroll();
                        // The inline auth panel owns the frame: the paste lands in its field, never
                        // in the editor.
                        if view.auth_panel.is_some() {
                            session.paste_to_auth_panel(&text, &mut view);
                        } else {
                            session.handle_paste(&text, &mut view);
                        }
                    }
                    // A mouse report reaches the transcript scroll dispatch's wheel branch;
                    // non-wheel reports are consumed inside.
                    UiInput::Mouse(event) => {
                        session.handle_mouse(event, &mut view);
                    }
                    // The headless plan's pause step: the queued keystroke batch ahead of this
                    // barrier is fully handled, so the parked suggestions materialize now — the
                    // same state the terminal loop's 50 ms idle tick produces.
                    UiInput::SettleIdle => {
                        session.materialize_editor_autocomplete(&mut view);
                    }
                    UiInput::Submit(text) => {
                        session.stop_selection_auto_scroll();
                        let dispatched = session
                            .submit_prompt(
                                &text,
                                crate::session_ui::SubmitBehavior::Steer,
                                &mut view,
                            )
                            .await;
                        if let Err(error) = dispatched {
                            // A rejected submission surfaces the `⚠ Error` row and keeps the client
                            // mounted with the draft restored.
                            session.error_row(&format!("{error:#}"), &mut view);
                            view.editor.set_text(&text);
                            session.dirty = true;
                        }
                        if session.pending_traces_login() {
                            session.run_traces_login(&mut view);
                        }
                    }
                    UiInput::Timestamp(_) => unreachable!("timing marker handled above"),
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
                        if let Ok((_width, height)) = crossterm::terminal::size() {
                            view.set_terminal_rows(height);
                        }
                    }
                    UiInput::WaitIdle { .. } | UiInput::SubmitAndSettle { .. } => {
                        unreachable!("barrier handled above")
                    }
                }
                // Paint the handled input in this iteration: the select below can otherwise wait
                // out its 50ms tick before the next draw, felt as keystroke-to-render lag. A
                // handoff paints nothing: the next surface owns the pane.
                if let Some(renderer) = renderer.is_terminal_mut() {
                    if !session.open_agents_view && session.pending_selection.is_none() {
                        // The inline paint must reflect tray state the handled key just armed (the
                        // Ctrl+C exit hint): the refresh below the select only reaches the frame
                        // gate, and the inline paint clears `dirty` — an idle terminal would
                        // otherwise never show the armed hint.
                        view.chrome.tray_override = session.tray_override(&view);
                        crate::app::draw(renderer, &mut view)?;
                        // The 16ms gate measures its interval from this frame.
                        last_render_at = Some(Instant::now());
                        last_pulse_phase = view.pulse_frame;
                        render_deadline = None;
                    }
                    session.dirty = false;
                }
                // An exit key must not wait out the select tick before the bounded shutdown path
                // runs.
                if !running {
                    break;
                }
                // `exit_requested` is the leave-now signal (agents-back, `/resume`, `/exit`): the
                // teardown below must run this iteration, not after the select's 50ms idle tick
                // parks the loop — that park reads as switch latency. A HANDOFF takes the leave now
                // (its next surface owns the pane). A non-handoff exit keeps the tail pass: its
                // frame gate paints the final chat frame the exit's main-screen flush shows;
                // headless keeps the tail pass so captured frames stay identical.
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
                // Headless input keeps the one-step-per-iteration order the plans were written
                // against: every step renders before the next applies (the captured frame sequence
                // IS the verifier evidence). The terminal path keeps the full batch drain.
                if !renderer.is_terminal() {
                    inputs_pending = false;
                }
            } else {
                // Without this arm the drain loop would spin on the empty queue — the select
                // below would never run again, starving every render and input after the first
                // batch.
                inputs_pending = false;
            }
        }
        // The headless exit gate: the plan completed, and the run ends once every settle member
        // drains (an in-flight `/share` upload or inline auth flow holds the run open like an
        // active turn; a live terminal never ends the run on its own). The members are snapshotted
        // so the bound below can name what stuck.
        let settle = headless_done.then(|| {
            HeadlessSettle::snapshot(&session, &view, pending.len(), wait_idle_deadline.is_some())
        });
        if let Some(settle) = settle {
            if settle.settled() {
                break;
            }
            // The settle bound: the gate's wait is the harness's only unbounded one, so a member
            // that never drains fails the run with its name instead of wedging the test binary
            // forever (the CI wedge family).
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

        // An exit key must not wait out the select: the loop condition consumes
        // `running`/`exit_requested` at the NEXT wake, and the input batch's bare `break` only
        // leaves the batch. The frame arm is the one that can wake now, so a pending exit takes it
        // immediately — the tail pass paints its final frame within the same iteration.
        if (!running || session.exit_requested)
            && render_deadline.is_none_or(|deadline| deadline > Instant::now())
        {
            render_deadline = Some(Instant::now());
        }
        // The frame-wake inventory: every pending-work state whose observation needs a loop
        // iteration arms the frame deadline here, pre-select. A dirty frame (the open's first
        // paint; a keystroke's toast or hint) must not park behind a select that has no other wake.
        // The headless barriers' deadlines and the hint/toast expiry arm HERE, not after the frame
        // gate.
        if session.dirty && render_deadline.is_none() {
            render_deadline = Some(Instant::now());
        }
        for deadline in [
            wait_idle_deadline,
            wait_render_deadline,
            settle_target.map(|(_, deadline)| deadline),
        ]
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
        // The animating loader's next phase boundary: every paint clears
        // the deadline it satisfied, and the boundary is the only wake a
        // quiet turn has between stream events (a running tool, a
        // provider gap, silent thinking) — without this arm the select
        // parked until the 2s bash-activity poll, freezing the spinner
        // and skipping whole seconds of the elapsed counter.
        if let Some(started) = anim_started {
            let next = next_spinner_deadline(started, Instant::now());
            if render_deadline.is_none_or(|armed| next < armed) {
                render_deadline = Some(next);
            }
        }
        let was_active = session.turn_active;
        // The quiet tick's arming state, snapshotted before the select: the arm future reads these
        // locals instead of borrowing the surface.
        let autocomplete_pending = view.editor.has_pending_autocomplete();
        let auto_scroll_armed = session.selection_auto_scroll_armed();
        let bash_refresh_wanted = session.kernel_bash_supported();
        let factory_refresh_wanted = session.factory_activity_supported();
        // A settle waiting out a member is pending work like the
        // autocomplete park: the gate runs at the loop top, so its
        // re-check (and the settle bound's expiry) needs this arm's
        // wake — a fully quiet select would otherwise park the
        // settle forever, and the bound itself fires only on an
        // iteration. Terminal runs never arm it (`headless_done`
        // exists only on the headless harness).
        let settle_recheck_wanted = headless_done && headless_settle_pending;
        // The window anchors at the first iteration that sees pending work: another arm's
        // wake must not restart it, or a streaming reply starves the parked request.
        quiet_tick_deadline = if autocomplete_pending || auto_scroll_armed || settle_recheck_wanted
        {
            quiet_tick_deadline.or_else(|| Some(Instant::now() + QUIET_TICK_INTERVAL))
        } else {
            None
        };
        tokio::select! {
            maybe_event = async {
                // A closed channel's recv() resolves None instantly and forever; while the
                // reconnect driver owns the run (§10.2) that always-ready arm would hot-spin the
                // loop and starve the tokio timers. Park the arm instead: the tick drives the
                // retries.
                if events_closed && reconnect.is_some() {
                    std::future::pending::<()>().await;
                }
                events.recv().await
            } => {
                                if let Some(event) = maybe_event {
                    session.apply_client_event(event, &mut view);
                    // Batch the rest of the queued frames: a stream burst applies as one
                    // transcript pass instead of one full re-layout per frame.
                    while let Ok(event) = events.try_recv() {
                        session.apply_client_event(event, &mut view);
                    }
                    // A succeeded compaction rebuilt the durable transcript: replace the view's
                    // chat with it, and refresh the tray usage the same way a settled turn does.
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
                    // A `session_binding` supersede notice: the session lives under a new active
                    // id, so re-attach to it — the transcript rebuilds from the snapshot (silent,
                    // no banner). A failed re-attach changes nothing (the old one detaches only
                    // after a new attach succeeds); the next supersede notice or submit-path retry
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
                    // An update close frame arms the reconnect driver immediately: the doomed
                    // connection's reader task is gone, but the client retains an event sender, so
                    // the channel itself never closes - the frame, not the EOF, is the trigger
                    // (spec §10.2). An update closing outranks a shutdown recovery in flight (TS
                    // #2458): the §10.2 resume contract replaces it.
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
                    // An announced non-update closing arms the bounded shutdown recovery instead:
                    // no-op unless the notice says the daemon itself is going down.
                    arm_shutdown_recovery(
                        &mut session,
                        &mut view,
                        &mut reconnect,
                        &mut session_reconnect,
                    );
                    // A dead direct worker link arms the session re-attach driver: the warning
                    // row rides the chat while the driver retries.
                    if session_reconnect.is_none() {
                        if let Some(lost) = session.transport_lost.take() {
                            // A supervisor loss retained while the direct link lived: the
                            // supervisor client is dead, so the session-plane retry loop could
                            // never restore it — the full reconnect driver replaces the client and
                            // reattaches.
                            if supervisor_lost && reconnect.is_none() {
                                session.note_as(
                                    "the daemon connection closed — reconnecting…",
                                    crate::chat::StatusKind::Warning,
                                    &mut view,
                                );
                                reconnect = Some(ReconnectLoop::start_lost());
                                supervisor_lost = false;
                            } else if reconnect.is_some() {
                                // A full reconnect driver owns the run — the dead direct link
                                // joins it instead of racing a session-plane retry through a
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
                        // §10: an update restart closed the daemon; the UI stays mounted and
                        // reconnects.
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
                        // TS #2458: the announced non-update closing owns the recovery, not the
                        // hiccup loop.
                    } else if reconnect.is_some() {
                        // Already reconnecting: the dead channel's None frames are expected.
                    } else {
                        // An unexpected connection loss (no update in flight) is a daemon hiccup,
                        // not a session end: the pane keeps its transcript and retries with the
                        // update restart's window and backoff; the window expires into the exit
                        // note.
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
                // One-shot: a ready arm would hot-spin the select.
                if reader_loss_handled {
                    std::future::pending::<()>().await;
                }
                reader_dead.changed().await
            } => {
                reader_loss_handled = true;
                if reader_death.is_ok() && *reader_dead.borrow_and_update() {
                    // An update restart's close frame can race this signal (the reader emits the
                    // frame, then dies): drain every frame the reader already delivered before
                    // deciding, so the update's own reconnect driver owns the recovery.
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
                        // The announced non-update closing owns the recovery: the supervisor
                        // socket's death joins its driver.
                    } else if session.client.direct_session_id().is_some() {
                        // A supervisor socket loss while a live direct link still serves the
                        // session is not a pane-level loss: retain the loss instead of recovering,
                        // and hand it to the full reconnect driver when the direct link later dies.
                        supervisor_lost = true;
                    } else if session_reconnect.is_some() {
                        // The direct link already died and the session-plane driver is retrying
                        // through the NOW-DEAD supervisor: stop it (it would ride a dead client)
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
                // The headless driver drops its sender after HeadlessDone; a closed recv is
                // always ready and would starve turn events while the final submitted prompt is
                // still settling.
                if headless_done {
                    std::future::pending::<Option<UiInput>>().await
                } else {
                    ui_rx.recv().await
                }
            } => {
                if let Some(input) = maybe_input {
                    // A keystroke restarts the window: the rest of a typed burst (a
                    // command plus its Enter) applies before a parked request materializes.
                    if matches!(input, UiInput::Key(_) | UiInput::Paste(_)) {
                        quiet_tick_deadline = None;
                    }
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
            maybe_factory = factory_rx.recv() => {
                if let Some(update) = maybe_factory {
                    session.apply_factory_update(update, &mut view);
                }
            }
            maybe_commands = commands_rx.recv() => {
                if let Some(update) = maybe_commands {
                    session.apply_command_catalog(update, &mut view);
                }
            }
            maybe_prompt = prompt_rx.recv() => {
                if let Some(note) = maybe_prompt {
                    // Protocol corruption stays fatal exactly like the inline submit's ladder.
                    session.apply_prompt_outcome(note, &mut view).await?;
                }
            }
            _reconnect_tick = async {
                // Park the tick while an attempt is in flight: the armed `next_attempt` is in the
                // past, so an unparked tick would busy-spin the loop for the attempt's duration.
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
                            // The daemon never came back within the reconnect timeout — the
                            // saved-transcript close (the session file survives on disk).
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
                let socket_path = options.socket_path.clone();
                let (attempt_tx, attempt_rx) = tokio::sync::oneshot::channel();
                reconnect_connect = Some(attempt_rx);
                reconnect_attempt_in_flight = true;
                // The shutdown recovery's discovery waits no longer than the bound — one bounded
                // connect+hello per poll (the resume/hiccup windows keep the retrying helper).
                let shutdown = matches!(kind, RecoveryKind::Shutdown);
                tokio::spawn(async move {
                    // No outer timeout: dropping the future mid-attempt would cancel an
                    // in-flight handshake without its reader abort running (a leaked reader and
                    // socket). The leg self-bounds — every attempt carries its own budgets.
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
                    // Nothing in flight: park the arm — the type is inferred from the in-flight
                    // arm, and the tick is the only spawner (a plain `None` return would hot-spin).
                    None => std::future::pending().await,
                }
            } => {
                reconnect_connect = None;
                reconnect_attempt_in_flight = false;
                // The deadline check runs here too: the tick arm parks while an attempt is in
                // flight, so the window can never overrun its advertised bound by more than the
                // in-flight attempt's connect leg.
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
                            // The daemon never came back within the reconnect timeout — the
                            // saved-transcript close (the session file survives on disk).
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
                        // The reattach self-bounds (a timeout cannot cancel the failure-path
                        // client close); the budget's expiry is a RETRY outcome, never a fatal
                        // one (§10.4: a queued attach can legitimately wait out a slow restore).
                        match session.reattach_after_recovery(client, &mut view, kind).await {
                            Ok(crate::session_ui::ReattachOutcome::Attached) => {
                                events = fresh_events;
                                events_closed = false;
                                reader_dead = session.client.reader_dead();
                                // The fresh connection owes nothing to the old one's loss states: a
                                // retained supervisor-loss flag or a session-plane retry left over
                                // from before the reconnect must not fire on the new link.
                                supervisor_lost = false;
                                session_reconnect = None;
                                // Re-arm the loss watch for the fresh connection: the new client's
                                // supervisor reader can die later, and the one-shot latch must not
                                // park that loss.
                                reader_loss_handled = false;
                                session.reconnect = None;
                                reconnect = None;
                                session.dirty = true;
                            }
                            Ok(crate::session_ui::ReattachOutcome::AttachBudgetExceeded) => {
                                // The queued attach outlived the attempt's budget (a slow restore):
                                // schedule another on both paths (§10.4 — never a fatal exit).
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
                                // An unexpected-loss reattach failure is a hiccup like any other
                                // (the worker still respawning), and a shutdown recovery retries
                                // until its own bound lands the saved-transcript close: keep
                                // retrying through the window instead of exiting — the pane never
                                // dies to it (the operator's kicked-out class).
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
                        // The attempt leg was dropped: the next tick re-arms.
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
                // The user switched sessions while the link was down: the new attach owns its own
                // connection, so this driver stops.
                if state.active_session_id != session.active_session_id {
                    continue;
                }
                // The reconnect attempt's budget covers the attach alone: the surface is already
                // up and its dock holds, so the first-frame fold's bounded fetches cannot eat the
                // 10s attempt budget on a slow daemon.
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
                        // The resynced transcript replaces the chat, then the reconnected status
                        // lands on the rebuilt chat.
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
                        session.spawn_heartbeat_refresh();
                        session.dirty = true;
                    }
                    Ok(Err(error)) => {
                        let mut state = state;
                        state.last_error = format!("{error:#}");
                        if tokio::time::Instant::now() > state.deadline {
                            // The window expired: the last error surfaces as the closed event's
                            // error row, and the UI stays mounted.
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
                // The quiet tick runs only while work is actually pending: a parked editor
                // autocomplete request (suggestions resolve asynchronously after the keystroke
                // batch, so the dropdown opens only once typing pauses) or an armed selection
                // auto-scroll. An idle surface parks this arm.
                match quiet_tick_deadline {
                    Some(deadline) => {
                        tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
                    }
                    None => std::future::pending::<()>().await,
                }
            } => {
                quiet_tick_deadline = None;
                session.materialize_editor_autocomplete(&mut view);
                session.selection_auto_scroll_tick(&mut view);
            }
            () = async {
                // The 2s bash-activity poll, on its own absolute deadline and only on daemons that
                // advertise the kernel-bash registry (without the capability every fire was a
                // no-op, so the arm parks).
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
            () = async {
                // The factory lane's 2s poll: the bash poll's cadence
                // and gate, armed on daemons that advertise the
                // factory lane. The poll runs whether or not the page
                // is open (the dock's factory count stays live); an
                // open page adds its selected run's watch ahead of the
                // graph inside the same serialized cycle.
                if !factory_refresh_wanted {
                    std::future::pending::<()>().await;
                }
                tokio::time::sleep_until(
                    tokio::time::Instant::from_std(last_factory_refresh + Duration::from_secs(2)),
                )
                .await;
            } => {
                last_factory_refresh = Instant::now();
                session.spawn_factory_refresh();
            }
            _frame = async {
                match render_deadline {
                    Some(deadline) => {
                        tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
                    }
                    None => std::future::pending::<()>().await,
                }
            } => {
                // The coalesced frame's deadline arrived: the render gate below paints the
                // accumulated state now.
            }
        }

        session.sync_goal_tray(&mut view);

        // Spinner animation: the wall clock drives the phase, not the render rate — the frame gate
        // below caps renders, and only a phase change dirties the frame.
        let animating = session.turn_active
            || view.retry.is_some()
            || view.compaction.is_some()
            || view.share_loader.is_some();
        if animating {
            let now = Instant::now();
            let started = *anim_started.get_or_insert(now);
            let phase = (now.duration_since(started).as_millis() / SPINNER_INTERVAL_MS) as usize;
            view.pulse_frame = phase;
            if phase != last_pulse_phase {
                session.dirty = true;
            }
            // Arm the next phase boundary: without a deadline the select
            // would only wake on the 50ms tick, adding up to a full tick
            // of spinner latency to every phase change.
            let next_phase = next_spinner_deadline(started, now);
            if render_deadline.is_none_or(|deadline| deadline > next_phase) {
                render_deadline = Some(next_phase);
            }
        } else {
            anim_started = None;
            last_pulse_phase = usize::MAX;
        }

        // The Ctrl+C exit hint expires on a timer: once the window passed, the hint row repaints
        // away — the expiry's wake arm lives in the pre-select inventory, and the same
        // iteration's frame gate repaints it away.
        if session.ctrl_c_hint_expiry().is_some() {
            hint_painted = true;
        } else if hint_painted {
            session.dirty = true;
            hint_painted = false;
        }

        // The action toasts auto-dismiss on their TTL: once one goes, the overlay repaints away.
        if view.toasts.prune_expired(Instant::now()) {
            session.dirty = true;
        }

        // The tray override row follows the session's hint state on every frame. Refreshed here —
        // after the select, right before the paint — because a loop-top refresh goes stale across
        // the select's sleep: the expiry wake would repaint the hint with the pre-sleep value.
        view.chrome.tray_override = session.tray_override(&view);

        // The frame gate: at most one render per MIN_RENDER_INTERVAL_MS — every state change inside
        // the window coalesces into the next frame (a stream burst renders at most one frame per
        // tick), and a dirty state waits for the deadline arm above instead of burning a render
        // now.
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
                    // The attach fold arms this once: the first frame that renders the rebuilt
                    // transcript materializes its visible window, so return that freed heap right
                    // after the frame paints instead of keeping the resume's peak resident.
                    if session.take_trim_after_frame() {
                        pa_types::memory_release::trim_freed_heap();
                    }
                } else {
                    render_deadline = Some(last_render_at.unwrap() + MIN_RENDER_INTERVAL);
                }
            } else {
                // Headless capture keeps the per-change frame sequence
                // the verifiers assert on: no wall-clock interval applies.
                // The paint bookkeeping matches the terminal's: a paint
                // satisfied the armed deadline, and the pre-select
                // inventory re-arms every wake still pending, so the
                // harness runs the terminal's wake path.
                renderer.render_headless(&mut session, &mut view);
                session.dirty = false;
                last_pulse_phase = view.pulse_frame;
                render_deadline = None;
            }
        } else if render_deadline.is_some_and(|deadline| deadline <= Instant::now()) {
            // A fired deadline with nothing dirty to paint must not re-fire on every iteration
            // (the arm would return immediately): drop it. A future arm (the spinner's next phase
            // boundary) stays — the select needs that wakeup.
            render_deadline = None;
        }
        if session.exit_requested {
            session.exit_reason = "session_request";
            running = false;
        }
    }

    // The run decided to leave: arm the force-quit deadline so every cleanup step below is
    // best-effort — a wedged shutdown cannot hold the process open past it. A handoff (agents-back,
    // a `/resume` selection) is a view switch, not an exit: arming here turned a busy box's slow
    // switch into a mid-teardown process kill ("shutdown stalled; forced exit.", the live report),
    // so the deadline covers only the leaves that end this process.
    let handing_off = session.open_agents_view || session.pending_selection.is_some();
    if renderer.is_terminal() && !handing_off {
        exit_guard.arm_for_exit();
    }
    // A handoff stashes the live draft for the session being left; every exit releases the
    // run's binding (a held draft stays in the store for the next view).
    if session.open_agents_view || session.pending_selection.is_some() {
        session.stash_draft_for_agents_view(&view);
        // The cross-view layout handoff (view::handoff): hold the last frame's visible-window packs
        // keyed by the LATEST event sequence this run has seen, so the unchanged-session re-entry's
        // first draw reuses them. A cursor-less attach never keys (the collapsed default identity
        // could alias).
        if session.attach_cursor_present {
            view.stash_layout_handoff(
                &session.session_id,
                &session.attach_event_generation,
                session.last_event_sequence,
            );
        }
    }
    session.release_prompt_stash_session();
    // Fetch the session stats while the connection is alive, then print the resume hint after
    // teardown; the agents-view handoff never prints it, so the round-trip is dead work on that
    // path.
    let resume_hint = if session.open_agents_view {
        None
    } else {
        session.exit_resume_hint().await
    };
    // Detach explicitly so the session's attached-client count stays honest; bounded hard: a
    // wedged worker socket can never hold the exit path. The agents-view handoff fires the detach
    // in the background instead (bookkeeping must not delay the switch).
    if session.open_agents_view {
        session.detach_for_handoff();
    } else {
        session.detach_for_exit().await;
    }
    // `tui exit` (schema v1): how the run ended. Bounded the same way as the detach — telemetry
    // must never hold the exit path open. The handoff still emits the event but does not wait for
    // the flush.
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
    // Agents-back and `/resume` hand the pane to the agents view; the alternate screen stays in
    // place for it (TS `stop({ preserveAltScreen: true })`).
    let preserve_alt_screen = session.open_agents_view;
    let outcome = InteractiveOutcome {
        active_session_id: session.active_session_id.clone(),
        session_id: session.session_id.clone(),
        resume_hint,
        last_assistant_text: session.last_assistant_text.clone(),
        frames: renderer.finish(&mut view, preserve_alt_screen),
        // The headless OSC 52 capture (terminal runs wrote the sequences to stdout as they
        // happened).
        clipboard_emissions: session.take_osc_emissions(),
        return_to_agents_view: preserve_alt_screen,
        agents_view_scope: session.scoped_agents_view.take(),
        selection_request: session.pending_selection,
        copies: std::mem::take(&mut session.copies),
        opened_urls: std::mem::take(&mut session.opened_urls),
        // The view's status line keeps the wait notice when the chat hands back.
        agents_view_notice: if waited_for_update_restart && preserve_alt_screen {
            Some(crate::update_restart_wait::DAEMON_UPDATE_RESTART_WAIT_NOTICE.to_string())
        } else {
            None
        },
        handoff_seeds: view.handoff_seeds,
    };
    // The agents-view handoff's background detach owns this connection now; every other exit
    // closes it here.
    if !preserve_alt_screen {
        session.client.close();
    }
    // A handoff lets the process keep running: retire the watchdog. Every other completion is a
    // process exit, where the deadline dies with the process — or fires when the exit wedged,
    // which is the point.
    if outcome.return_to_agents_view || outcome.selection_request.is_some() {
        exit_guard.cancel();
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The boundary the select arms is always the current phase's
    /// 80ms edge — the wake must precede the phase change it observes
    /// (an off-by-one parks the loop for a whole boundary). Samples sit
    /// at least a millisecond inside their phase because `Instant`
    /// round-trips can lose sub-millisecond ticks on the platform
    /// clock, and the phase is floored from whole milliseconds.
    #[test]
    fn spinner_deadline_is_the_current_phase_edge() {
        let started = Instant::now();
        let at = |ms: u64| started + Duration::from_millis(ms);
        assert_eq!(next_spinner_deadline(started, started), at(80));
        assert_eq!(next_spinner_deadline(started, at(1)), at(80));
        assert_eq!(next_spinner_deadline(started, at(79)), at(80));
        assert_eq!(next_spinner_deadline(started, at(81)), at(160));
        assert_eq!(next_spinner_deadline(started, at(161)), at(240));
        assert_eq!(next_spinner_deadline(started, at(239)), at(240));
    }
}
