//! The render sink concern: the terminal/headless renderer, the startup chrome seeding, the tmux
//! keyboard check, the suspend-cycle terminal handoff, and the exit flush rows.

use super::{
    mpsc, terminal, AgentView, Duration, ExitGuard, HeadlessStep, InteractiveOptions, KeyEvent,
    Result, SessionUi, Terminal, UiInput, UiMode,
};

/// One typed string as key events: characters become `Char` presses, `\n`
/// becomes Enter, and `\t` becomes Tab (the keys autocomplete reacts to).
fn typed_keys(text: &str) -> Vec<KeyEvent> {
    text.chars()
        .map(|c| match c {
            '\n' | '\r' => KeyEvent::new(
                crossterm::event::KeyCode::Enter,
                crossterm::event::KeyModifiers::NONE,
            ),
            '\t' => KeyEvent::new(
                crossterm::event::KeyCode::Tab,
                crossterm::event::KeyModifiers::NONE,
            ),
            other => KeyEvent::new(
                crossterm::event::KeyCode::Char(other),
                crossterm::event::KeyModifiers::NONE,
            ),
        })
        .collect()
}

/// Seed the static chrome state for a fresh interactive run: splash version/cwd, top-bar name,
/// the `manage` hint for persisted sessions, and the zero dock a fresh session mounts.
pub(super) fn apply_startup_chrome(view: &mut AgentView, options: &InteractiveOptions) {
    view.chrome.version.clone_from(&options.version);
    view.chrome.cwd = options.cwd.to_string_lossy().to_string();
    view.chrome.chat_name = crate::chrome::display_name(&view.chrome.cwd);
    view.chrome.show_manage = !options.no_session;
    view.chrome.tray_depth = options.session_rlm_depth;
    view.chrome.activity = Some(crate::chrome::ActivityDock::default());
}

/// The tmux keyboard notice (TS `checkTmuxKeyboardSetup`): warn once per start when tmux runs
/// without `extended-keys`; a timeout or error suppresses the notice.
pub(super) async fn check_tmux_keyboard_setup() -> Option<String> {
    if std::env::var("TMUX").is_err() {
        return None;
    }
    let query = |option: &'static str| async move {
        tokio::time::timeout(
            Duration::from_secs(2),
            tokio::task::spawn_blocking(move || {
                std::process::Command::new("tmux")
                    .args(["show", "-gv", option])
                    // No inherited fds: a probe must never hold the terminal the TUI owns —
                    // no TUI child ever holds /dev/tty.
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::null())
                    .output()
            }),
        )
        .await
        .ok()
        .and_then(Result::ok)
        .and_then(Result::ok)
        .and_then(|output| {
            if output.status.success() {
                Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
            } else {
                None
            }
        })
    };
    let extended_keys = query("extended-keys").await?;
    if extended_keys != "on" && extended_keys != "always" {
        return Some(
            "tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.".to_string(),
        );
    }
    None
}

/// Rendering sink: the real terminal or headless frame capture.
pub(super) enum Renderer {
    Terminal {
        term: Terminal<crate::hyperlinks::LinkBackend>,
        /// The `terminal.fullscreenMouse` setting: mouse tracking re-enables on resume.
        mouse: bool,
        /// The reader's channel and force-quit guard: the external-editor cycle stops and
        /// respawns the session reader around the child run.
        ui_tx: mpsc::UnboundedSender<UiInput>,
        exit_guard: ExitGuard,
    },
    Headless {
        width: u16,
        height: u16,
        frames: Vec<String>,
    },
}

/// The renderer handoff of one suspend cycle: `stop` hands the terminal to the shell (SGR
/// mouse tracking off, alt screen left and flushed into native scrollback, raw mode off);
/// `resume` takes it back after SIGCONT with every mode re-applied.
pub(super) struct TerminalHandoff<'a> {
    pub(super) renderer: &'a mut Renderer,
    pub(super) view: &'a mut AgentView,
}

impl crate::suspend::SuspendTerminal for TerminalHandoff<'_> {
    fn stop(&mut self) -> Result<()> {
        self.renderer.suspend(self.view)
    }

    fn resume(&mut self) -> Result<()> {
        self.renderer.resume()
    }
}

/// Start the session surface's terminal input reader. One reader thread feeds the loop. The reader
/// also observes Ctrl+C pairs for the exit guard: this thread stays alive when the UI loop is
/// wedged, so the force-quit contract holds regardless of loop state. The paste-aware variant
/// coalesces a marker-less multi-line keystroke burst into one editor paste (TS
/// `isRawMultilinePaste`).
pub(super) fn spawn_session_reader(ui_tx: mpsc::UnboundedSender<UiInput>, exit_guard: ExitGuard) {
    crate::input::spawn_paste_aware_reader(move |input| match input {
        crate::input::ReaderInput::BurstPaste(text) => ui_tx.send(UiInput::Paste(text)).is_ok(),
        // A report the guard reassembled from a sequence crossterm's reader split at a
        // committed-`ESC` read boundary: consumed unless tracking is active, like the terminal's
        // mouse events.
        crate::input::ReaderInput::Mouse(report) => {
            if crate::mouse_tracking::active() {
                ui_tx.send(UiInput::Mouse(report)).is_ok()
            } else {
                true
            }
        }
        crate::input::ReaderInput::Event(event) => match event {
            crossterm::event::Event::Key(key) => {
                exit_guard.observe_key(&key);
                ui_tx.send(UiInput::Key(key)).is_ok()
            }
            crossterm::event::Event::Paste(text) => ui_tx.send(UiInput::Paste(text)).is_ok(),
            // A resize forces a full re-render (TS widthChanged/heightChanged).
            crossterm::event::Event::Resize(..) => ui_tx.send(UiInput::Resize).is_ok(),
            // Mouse reports are always consumed (nothing downstream understands them): wheel
            // turns reach the loop only while tracking is active (TS consumes reports even when
            // tracking is disabled).
            crossterm::event::Event::Mouse(mouse) => {
                if !crate::mouse_tracking::active() {
                    true
                } else if let Some(event) = crate::mouse::from_crossterm(mouse) {
                    ui_tx.send(UiInput::Mouse(event)).is_ok()
                } else {
                    true
                }
            }
            _ => true,
        },
    });
}

impl Renderer {
    pub(super) fn setup(
        ui: UiMode,
        ui_tx: mpsc::UnboundedSender<UiInput>,
        exit_guard: ExitGuard,
        mouse: bool,
        surface_mounted: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<Renderer> {
        match ui {
            UiMode::Terminal => {
                // The raw-mode bracket's own `cfmakeraw` write clears IXON, which is the
                // kernel's one trigger for lifting a pending Ctrl+S stop: a tty stopped at the
                // shell prompt self-heals here (verified by the flow e2e's launch route).
                terminal::enable_raw_mode()?;
                // The terminal state changed: every later setup step is fallible (the alt-screen
                // enter, the mode enables, the terminal construction) and an error from any of them
                // still owns the release — the flag arms here, not at the end of setup.
                surface_mounted.store(true, std::sync::atomic::Ordering::SeqCst);
                // Adopt the alternate screen the previous surface left in place: only the first
                // surface of the process enters it, so a view switch never flashes the primary
                // screen. The enter itself is ARMED, not written: it rides the first draw's
                // flush (see `altscreen::arm_first_draw_mount`).
                crate::altscreen::arm_first_draw_mount();
                // SGR mouse tracking follows the fullscreen surface in and out (TS enables it
                // blind — probing is not viable under tmux and unsupporting terminals ignore
                // the mode-sets).
                if mouse {
                    crate::mouse_tracking::enable(&mut std::io::stdout())?;
                }
                // Bracketed paste and the kitty keyboard protocol come up with the raw-mode
                // bracket: pastes arrive as one chunk, and the kitty probe (once per process —
                // see `enhanced_keys`) runs before the reader thread starts polling.
                crate::enhanced_keys::enable(&mut std::io::stdout())?;
                spawn_session_reader(ui_tx.clone(), exit_guard.clone());
                let terminal = Terminal::new(crate::hyperlinks::stdout_backend())?;
                // The adopted buffer still holds the previous view's frame, so the clear escape
                // must never reach the pane on its own: the armed mount's clear and cursor hide
                // ride the first draw's single flush (see `altscreen::take_first_draw_mount`) —
                // a clear queued HERE would let any mid-gap flush carry it out early.
                Ok(Renderer::Terminal {
                    term: terminal,
                    mouse,
                    ui_tx,
                    exit_guard,
                })
            }
            UiMode::Headless(plan) => {
                // The headless harness drives the same dispatch, so the tracking state must
                // read active; the sequence write is gated on a real stdout inside the enable.
                if mouse {
                    crate::mouse_tracking::enable(&mut std::io::stdout())?;
                }
                let steps = plan.steps;
                tokio::spawn(async move {
                    for step in steps {
                        match step {
                            HeadlessStep::Submit(text) => {
                                if ui_tx.send(UiInput::Submit(text)).is_err() {
                                    return;
                                }
                            }
                            HeadlessStep::SubmitAndSettle { text, timeout_ms } => {
                                if ui_tx
                                    .send(UiInput::SubmitAndSettle { text, timeout_ms })
                                    .is_err()
                                {
                                    return;
                                }
                            }
                            HeadlessStep::Type(text) => {
                                for key in typed_keys(&text) {
                                    if ui_tx.send(UiInput::Key(key)).is_err() {
                                        return;
                                    }
                                }
                            }
                            HeadlessStep::Paste(text) => {
                                if ui_tx.send(UiInput::Paste(text)).is_err() {
                                    return;
                                }
                            }
                            HeadlessStep::SettleIdle => {
                                if ui_tx.send(UiInput::SettleIdle).is_err() {
                                    return;
                                }
                            }
                            HeadlessStep::WaitIdle { timeout_ms } => {
                                if ui_tx.send(UiInput::WaitIdle { timeout_ms }).is_err() {
                                    return;
                                }
                            }
                            HeadlessStep::WaitRender { needle, timeout_ms } => {
                                if ui_tx
                                    .send(UiInput::WaitRender { needle, timeout_ms })
                                    .is_err()
                                {
                                    return;
                                }
                            }
                            HeadlessStep::WaitGone { needle, timeout_ms } => {
                                if ui_tx
                                    .send(UiInput::WaitGone { needle, timeout_ms })
                                    .is_err()
                                {
                                    return;
                                }
                            }
                            HeadlessStep::WaitMs(ms) => {
                                tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                            }
                            HeadlessStep::ScrollTop => {
                                if ui_tx.send(UiInput::ScrollTop).is_err() {
                                    return;
                                }
                            }
                            HeadlessStep::Mouse(sequence) => {
                                if crate::mouse_tracking::active()
                                    && crate::mouse::is_mouse_sequence(&sequence)
                                {
                                    if let Some(event) =
                                        crate::mouse::parse_sgr_mouse_event(&sequence)
                                    {
                                        if ui_tx.send(UiInput::Mouse(event)).is_err() {
                                            return;
                                        }
                                    }
                                }
                            }
                            HeadlessStep::Key(key) => {
                                if ui_tx.send(UiInput::Key(key)).is_err() {
                                    return;
                                }
                            }
                        }
                    }
                    let _ = ui_tx.send(UiInput::HeadlessDone);
                });
                Ok(Renderer::Headless {
                    width: plan.width,
                    height: plan.height,
                    frames: Vec::new(),
                })
            }
        }
    }

    /// Hand the terminal back to the process (raw mode off, alternate screen left and flushed,
    /// cursor visible) so an interactive client command can prompt on it. Headless verification
    /// runs keep their plain pipes.
    fn suspend(&mut self, view: &mut AgentView) -> Result<()> {
        match self {
            Renderer::Terminal { .. } => {
                let _ = crate::mouse_tracking::disable(&mut std::io::stdout());
                // The raw-mode bracket takes the enhanced-key modes with it; `resume` re-enables
                // both.
                let _ = crate::enhanced_keys::disable(&mut std::io::stdout());
                self.flush_to_main_screen(view)?;
                crate::exit_restore::terminal_release_tail(&mut std::io::stdout());
                Ok(())
            }
            Renderer::Headless { .. } => Ok(()),
        }
    }

    /// Take the terminal back after a suspended client command.
    pub(super) fn resume(&mut self) -> Result<()> {
        match self {
            Renderer::Terminal { term, mouse, .. } => {
                // The raw re-arm's `cfmakeraw` write clears IXON - the kernel's one trigger
                // for lifting a pending Ctrl+S stop - so a stop armed at the shell never holds
                // the resume's repaint.
                terminal::enable_raw_mode()?;
                crate::altscreen::enter()?;
                // The suspend's release tail showed the cursor for the plain terminal; taking
                // the surface back hides it again — otherwise the visible cursor sits at a
                // stale position through the clear and the full repaint below.
                let _ = crossterm::execute!(std::io::stdout(), crossterm::cursor::Hide);
                // The raw-mode bracket re-arms the enhanced-key modes (the port resolves the kitty
                // capability once per process, so a resume re-applies the resolved state —
                // crossterm's support check monopolizes the event-reader lock and must not run on
                // the resume path).
                crate::enhanced_keys::enable(&mut std::io::stdout())?;
                if *mouse {
                    crate::mouse_tracking::enable(&mut std::io::stdout())?;
                }
                // A fresh full redraw: the suspended command left arbitrary output behind.
                term.clear()?;
                Ok(())
            }
            Renderer::Headless { .. } => Ok(()),
        }
    }

    /// Leave the alternate screen and paint the accumulated inline layout onto the main screen:
    /// the inline repaint flushes the fullscreen-era transcript into native scrollback, keeping
    /// the exit frame — and the resume hint printed below it — visible after the process exits.
    /// The kill-switch `PRIME_AGENT_TUI_EXIT_FLUSH=0` skips the paint (the alt screen is still
    /// left): the flush writes into the user's scrollback, so it can be disabled without a
    /// release if it misbehaves.
    fn flush_to_main_screen(&mut self, view: &mut AgentView) -> Result<()> {
        use std::io::Write;
        // Only the terminal renderer owns a real screen to flush; headless runs keep their plain
        // pipes.
        if !matches!(self, Renderer::Terminal { .. }) {
            return Ok(());
        }
        crate::altscreen::leave()?;
        if !exit_flush_enabled() {
            return Ok(());
        }
        let (width, height) = terminal::size()?;
        // The flush streams row-by-row in bounded chunks: a long transcript must reach the terminal
        // without ever holding the whole frame — the peak is one section plus one chunk.
        let mut out = std::io::stdout();
        view.stream_flush_to(&mut out, width as usize, height as usize)?;
        out.flush()?;
        Ok(())
    }

    /// Whether this run owns a real terminal (the force-quit guard arms on terminal runs; headless
    /// verification keeps deterministic teardown).
    pub(super) fn is_terminal(&self) -> bool {
        matches!(self, Renderer::Terminal { .. })
    }

    pub(super) fn is_terminal_mut(
        &mut self,
    ) -> Option<&mut Terminal<crate::hyperlinks::LinkBackend>> {
        match self {
            Renderer::Terminal { term, .. } => Some(term),
            Renderer::Headless { .. } => None,
        }
    }

    /// Capture one onboarding-pane frame as plain text (headless assertions): the pane replaces the
    /// whole session frame. A pane that has not changed does not add a duplicate frame.
    pub(super) fn render_headless_pane(&mut self, view: &mut AgentView) {
        let Renderer::Headless {
            width,
            height,
            frames,
        } = self
        else {
            return;
        };
        let text = crate::app::render_frame_text(view, *width, *height).join("\n");
        if frames.last().map(String::as_str) != Some(text.as_str()) {
            frames.push(text);
        }
    }

    /// The headless capture's frames (None on a terminal): the render barriers wait on these.
    pub(super) fn headless_frames(&self) -> Option<&[String]> {
        match self {
            Renderer::Headless { frames, .. } => Some(frames),
            Renderer::Terminal { .. } => None,
        }
    }

    /// Capture one frame as plain text (headless assertions).
    pub(super) fn render_headless(&mut self, session: &mut SessionUi, view: &mut AgentView) {
        let Renderer::Headless {
            width,
            height,
            frames,
        } = self
        else {
            return;
        };
        let text = crate::app::render_frame_text(view, *width, *height).join("\n");
        if std::env::var("PA_TUI_DEBUG_EVENTS").is_ok() {
            eprintln!(
                "[tui-frame] len={} has_second={} has_again={}",
                text.len(),
                text.contains("second turn"),
                text.contains("again")
            );
        }
        if frames.last().map(String::as_str) != Some(text.as_str()) {
            frames.push(text);
        }
        session.dirty = false;
    }

    /// Teardown. `preserve_alt_screen`: an exit that hands the pane to the agents view keeps the
    /// alternate screen for the adopting view, hides the cursor, and skips the main-screen flush —
    /// raw mode also stays on, because the in-process handoff gap would otherwise echo keypresses
    /// into the preserved frame (TS `pendingInputHandoff`).
    pub(super) fn finish(mut self, view: &mut AgentView, preserve_alt_screen: bool) -> Vec<String> {
        // The exit that ends the process stands the kitty probe down FIRST: an answer landing
        // after the pop below would re-arm CSI-u reporting on the parent shell (the "escape
        // codes while typing" leak). A handoff (preserve) keeps the process alive and the
        // next surface's probe — never released here.
        if !preserve_alt_screen && self.is_terminal() {
            crate::enhanced_keys::release_for_exit();
        }
        // The surface's input reader stands down FIRST: the drain below reads the tty through
        // crossterm's global event-reader lock, and a parked reader would hold it — the wake makes
        // the flagged reader exit now, and the next surface's mount joins an already-exited thread.
        crate::input::request_reader_stop();
        // In-flight kitty key releases are consumed before the terminal is restored: a
        // release that lands after raw mode is off would leak its escape sequence into the
        // parent shell over slow SSH. Runs on every exit — the agents-view handoff drains
        // too; headless runs skip it inside the drain. A handoff (preserve) keeps raw mode
        // on — the adopting surface's dispatch drops releases, so the handoff drain consumes
        // only what is already buffered.
        if preserve_alt_screen {
            crate::enhanced_keys::drain_for_handoff(&mut std::io::stdout());
        } else {
            crate::enhanced_keys::drain(&mut std::io::stdout());
        }
        // Tracking releases with the surface (disable written before leaving the alt screen).
        let _ = crate::mouse_tracking::disable(&mut std::io::stdout());
        // The enhanced-key modes release with the raw-mode bracket (the paste disable, the
        // kitty pop, and the modifyOtherKeys reset run for every exit, handoffs included).
        let _ = crate::enhanced_keys::disable(&mut std::io::stdout());
        match self {
            Renderer::Terminal { .. } => {
                if preserve_alt_screen {
                    // ratatui's `Terminal` drop restores the cursor its last frame hid: run the
                    // drop before the hide so the hide is the handoff's final word — the
                    // adopting mount must not race a stale show against its own hide.
                    let Renderer::Terminal { term, .. } = self else {
                        unreachable!("the arm matched the terminal renderer")
                    };
                    drop(term);
                    let _ = crossterm::execute!(std::io::stdout(), crossterm::cursor::Hide);
                } else {
                    let _ = self.flush_to_main_screen(view);
                    // The shared exit tail ends the parity teardown: the synchronized-output
                    // release, the SGR reset, the cursor show, and the cooked-tty verification
                    // end in the same terminal state every exit path guarantees.
                    crate::exit_restore::terminal_release_tail(&mut std::io::stdout());
                }
                Vec::new()
            }
            Renderer::Headless { frames, .. } => frames,
        }
    }
}

/// Encode the flushed rows into `buffer` as one write: each row starts at column 0 (`\r`, required
/// because raw mode maps `\n` to a bare line feed), rows are joined with CRLF, and a trailing CRLF
/// parks the cursor below the frame so whatever prints next starts on a fresh line.
pub(crate) fn write_flush_rows(buffer: &mut String, rows: &[crate::Line]) {
    for row in rows {
        buffer.push('\r');
        // An image-placement row is written raw: styling or padding would corrupt the placement.
        let raw: String = row.iter().map(|span| span.content.as_str()).collect();
        if crate::terminal_image::is_image_line(&raw) {
            buffer.push_str(&raw);
        } else {
            buffer.push_str(&crate::ansi::line_to_ansi(row));
        }
        buffer.push_str("\r\n");
    }
}

/// The main-screen exit flush is on unless `PRIME_AGENT_TUI_EXIT_FLUSH=0` opts out.
fn exit_flush_enabled() -> bool {
    std::env::var_os("PRIME_AGENT_TUI_EXIT_FLUSH").is_none_or(|value| value != "0")
}
