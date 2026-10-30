//! Terminal app: crossterm event loop driving an [`AgentView`] against a
//! [`SessionStream`]. Both the interactive product surface and the replay
//! verifier binary run through this single loop.

use crate::editor::{Editor, EditorEvent};
use crate::keys::key_event_to_id;
use crate::session::{SessionEvent, SessionStream};
use crate::theme::Theme;
use crate::view::AgentView;
use anyhow::Result;
use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
use crossterm::terminal::{self};
use ratatui::Terminal;
use std::io::stdout;
use std::time::Duration;

pub struct AppOptions {
    pub theme: String,
    /// Replay delay per entry while streaming history (ms). 0 = instant load.
    pub replay_delay_ms: u64,
    /// Auto-exit after this many ms of runtime (headless verification).
    pub auto_exit_ms: Option<u64>,
    /// Panic after the first paint (the exit-restore verifier's panic-path driver: a real unwind
    /// on the live surface must still leave the terminal whole).
    pub panic_after_frame: bool,
}

impl Default for AppOptions {
    fn default() -> Self {
        Self {
            theme: "prime".to_string(),
            replay_delay_ms: 0,
            auto_exit_ms: None,
            panic_after_frame: false,
        }
    }
}

#[must_use]
pub fn load_theme(name: &str) -> Theme {
    let mode = crate::theme::detect_color_mode();
    // The default brand theme when the caller passes none (empty) or an
    // unknown name; only known builtins resolve.
    let known = ["prime", "dark", "light"];
    let name = if known.contains(&name) { name } else { "prime" };
    Theme::builtin(name, mode)
}

/// Run the view against a session stream until the stream ends and the user exits. `on_submit`
/// receives editor submissions (unused in replay mode).
///
/// # Errors
///
/// Returns `Err` when the surface fails to mount or the replay loop fails; the exit restore runs
/// first, so the shell never keeps a TUI-state terminal.
pub fn run_app(
    stream: Box<dyn SessionStream>,
    options: &AppOptions,
    on_submit: Box<dyn FnMut(&str) + Send>,
) -> Result<()> {
    match run_app_surface(stream, options, on_submit) {
        Ok(()) => Ok(()),
        Err(error) => {
            crate::exit_restore::restore_terminal();
            Err(error)
        }
    }
}

fn run_app_surface(
    mut stream: Box<dyn SessionStream>,
    options: &AppOptions,
    mut on_submit: Box<dyn FnMut(&str) + Send>,
) -> Result<()> {
    // The TS theme emits raw ANSI color codes regardless of NO_COLOR; match
    // that so the same terminal renders the same frames either way.
    crossterm::style::force_color_output(true);
    // A panic anywhere between the mount below and the deliberate teardown must still hand
    // the terminal back whole (the same unwind-guard contract the session surface arms).
    let _surface_restore = crate::exit_restore::SurfaceRestore::armed();
    // Enable Windows VT processing before raw ANSI mode writes.
    pa_types::platform::console_init();
    // The raw-mode bracket's `cfmakeraw` write clears IXON, the kernel's one trigger for
    // lifting a pending Ctrl+S stop (see the flow e2e's launch route).
    terminal::enable_raw_mode()?;
    // The alternate screen mounts through the ownership module (the same `pendingAltScreenHandoff`
    // semantics the session surface uses), so the alt-screen state is tracked for every exit path.
    crate::altscreen::enter()?;
    // The replay surface owns the same enhanced-key modes as the session: bracketed pastes
    // arrive as one chunk.
    crate::enhanced_keys::enable(&mut std::io::stdout())?;
    let mut terminal = Terminal::new(crate::hyperlinks::stdout_backend())?;

    let theme = load_theme(&options.theme);
    let mut view = AgentView::new(theme);
    let mut running = true;
    let start = std::time::Instant::now();
    let mut stream_ended = false;

    loop {
        if !stream_ended {
            match stream.poll()? {
                SessionEvent::Item(item) => {
                    if let crate::session::TranscriptItem::ModelChange { provider, model_id } =
                        &item
                    {
                        view.chrome.model_id = Some(model_id.clone());
                        view.chrome.model_provider = Some(provider.clone());
                    }
                    view.push(item);
                    if options.replay_delay_ms > 0 {
                        std::thread::sleep(Duration::from_millis(options.replay_delay_ms));
                    }
                }
                SessionEvent::End => stream_ended = true,
            }
        }

        let (_w, h) = crossterm::terminal::size()?;
        view.set_terminal_rows(h);
        draw(&mut terminal, &mut view, ScrollbackFlush::Off)?;
        // The verifier's panic driver: the unwind must cross the live
        // surface's unwind guard, not the already-restored exit.
        assert!(
            !options.panic_after_frame,
            "pa-tui-replay: --panic-exit reached"
        );

        let timeout = Duration::from_millis(if stream_ended { 50 } else { 5 });
        if crossterm::event::poll(timeout)? {
            match crossterm::event::read()? {
                Event::Key(key) => {
                    handle_key(&mut view, key, &mut running, &mut *on_submit);
                }
                Event::Paste(text) => {
                    view.editor.handle_paste(&text);
                }
                _ => {}
            }
        }
        // Materialize once per loop turn: a parked request resolves right after its key, and a
        // background `@` search lands on a quiet turn.
        view.editor.materialize_autocomplete();
        let _ = view.editor.take_events();

        if let Some(ms) = options.auto_exit_ms {
            if start.elapsed() >= Duration::from_millis(ms) {
                running = false;
            }
        }
        if !running && stream_ended {
            break;
        }
        if !stream_ended {
            continue;
        }
        if !running {
            break;
        }
    }

    crate::exit_restore::restore_terminal();
    Ok(())
}

fn handle_key(
    view: &mut AgentView,
    key: KeyEvent,
    running: &mut bool,
    on_submit: &mut dyn FnMut(&str),
) {
    // App-level bindings: ctrl+c exits the app shell in replay mode; escape cancels
    // autocomplete.
    if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
        if view.editor.is_showing_autocomplete() {
            view.editor.cancel_autocomplete();
            return;
        }
        *running = false;
        return;
    }
    if key.code == KeyCode::Char('d') && key.modifiers.contains(KeyModifiers::CONTROL) {
        *running = false;
        return;
    }
    if key.code == KeyCode::Esc {
        view.editor.cancel_autocomplete();
        return;
    }
    if key.code == KeyCode::Char('o') && key.modifiers.contains(KeyModifiers::CONTROL) {
        // Ctrl+O cycles conversation detail: overview -> details -> all -> overview.
        view.cycle_detail();
        return;
    }
    let Some(id) = key_event_to_id(&key) else {
        return;
    };
    // Transcript viewport keys (consumed before the editor in fullscreen): page scroll,
    // top, follow.
    let (page_up, page_down, to_top, follow) = {
        let kb = view.editor.keybindings();
        (
            kb.matches(&id, "tui.viewport.pageUp"),
            kb.matches(&id, "tui.viewport.pageDown"),
            kb.matches(&id, "tui.viewport.top"),
            kb.matches(&id, "tui.viewport.follow"),
        )
    };
    if page_up {
        view.scroll_by(-(view.page_size() as isize));
        return;
    }
    if page_down {
        view.scroll_by(view.page_size() as isize);
        return;
    }
    if to_top {
        view.scroll_to_top();
        return;
    }
    if follow {
        view.scroll_to_bottom();
        return;
    }
    let is_paste_marker_key = false;
    let _ = is_paste_marker_key;
    view.editor.handle_input(&id);
    dispatch_events(&mut view.editor, on_submit);
}

pub fn dispatch_events(editor: &mut Editor, on_submit: &mut dyn FnMut(&str)) {
    for ev in editor.take_events() {
        match ev {
            EditorEvent::Submitted(text) => {
                editor.add_to_history(&text);
                on_submit(&text);
            }
            // This minimal harness owns no terminal clipboard channel; the full session UI
            // performs the copy.
            EditorEvent::Changed(_)
            | EditorEvent::AutocompleteToggled(_)
            | EditorEvent::ClipboardWrite(_) => {}
        }
    }
}

/// One paint's settle-armed scrollback flush request: `Off` paints the fullscreen frame
/// alone, while `Settle` runs the transcript delta flush inside the paint's
/// synchronized-output bracket. Every gate is resolved by the run loop AT THE PAINT CALL
/// SITE (nothing runs between that and the flush, and the paint bracket stays free of the
/// settings store's disk read): a settle arms the request, but a page fetch or a settings
/// change between the arm and this paint still decides it.
#[derive(Clone, Copy)]
pub(crate) enum ScrollbackFlush {
    Off,
    Settle {
        /// The `terminal.scrollbackFlush` setting, read live through the client-settings seam
        /// at the paint call site, so a settings toggle applies without a restart.
        scrollback_flush: bool,
        /// The transcript window's gap state: a gap row or an in-flight page blocks the flush.
        transcript_gap: bool,
    },
}

/// One paint's outcome: paint errors stay fatal in `draw`'s `Result`; a settle-armed
/// scrollback flush that failed after the surface recovered in place reports here instead,
/// so the run continues with an error row rather than tearing down the session.
pub(crate) struct Painted {
    pub(crate) scrollback_flush_error: Option<anyhow::Error>,
    /// A settle-armed scrollback flush appended rows into native scrollback this paint: the
    /// run's adoption telemetry fires once on it.
    pub(crate) scrolled_scrollback: bool,
}

pub(crate) fn draw(
    terminal: &mut Terminal<crate::hyperlinks::LinkBackend>,
    view: &mut AgentView,
    scrollback: ScrollbackFlush,
) -> Result<Painted> {
    // The mount sequences (the alt-screen adopt/enter, the queued clear, the cursor hide) ride
    // THIS draw's single flush: the first paint is the mount, and a mid-gap flush can never
    // carry the clear out early over it.
    let mounting = crate::altscreen::take_first_draw_mount();
    if mounting {
        let mut out = std::io::stdout();
        crate::altscreen::enter_queued(&mut out)?;
        crossterm::queue!(
            out,
            crossterm::terminal::Clear(crossterm::terminal::ClearType::All),
            crossterm::cursor::Hide
        )?;
    }
    let area = terminal.size()?;
    let frame_area = ratatui::layout::Rect::new(0, 0, area.width, area.height);
    let width = area.width as usize;
    let height = area.height as usize;
    let frame = view.render_frame(width, height);
    let cursor = view.frame_cursor();
    // The frame's embedded OSC 8 sequences drive the paint backend's hyperlink injection; install
    // the ranges before the draw (which strips the sequences from the painted cells).
    crate::hyperlinks::install_frame(&frame);
    // OSC 133 describes shell prompts, not alternate-screen rows. In iTerm2 it can
    // disable soft alternate-screen mode and let cursor moves clear the painted grid.
    // Keep those markers in the main-screen exit transcript only.
    // Fullscreen paint brackets the row diff in synchronized output so terminals never display
    // an intermediate, partly scrolled frame; a terminal without mode 2026 support ignores the
    // two escape sequences.
    crossterm::execute!(stdout(), terminal::BeginSynchronizedUpdate)?;
    // A settle-armed scrollback flush rides the same bracket: the alt-screen switch and the
    // transcript rows land with the repaint in one terminal update, so terminals with mode
    // 2026 support (tmux) never flash a half-updated pane. The gates run HERE, at flush time,
    // not at the arm: the setting reads live, the kill-switch re-reads the environment, and a
    // page fetch that started between the arm and this paint blocks the flush.
    let mut scrollback_flush_error = None;
    let mut scrolled_scrollback = false;
    if let ScrollbackFlush::Settle {
        scrollback_flush,
        transcript_gap,
    } = scrollback
    {
        if scrollback_flush && crate::interactive::exit_flush_enabled() && !transcript_gap {
            // Every step past the gate is best-effort: the bracket below must always reach
            // its release, and a broken surface (the same write failure that broke the row
            // writes also breaks the surface retakes) reports as the error row instead of a
            // fatal teardown.
            let mut surface_error = None;
            match crate::altscreen::leave() {
                Ok(()) => {
                    use std::io::Write;
                    let mut out = stdout();
                    let flushed = match view.stream_transcript_delta_to(&mut out, width) {
                        Ok(appended) => out.flush().map(|()| appended),
                        Err(error) => Err(error),
                    };
                    // The suspend-path sequence re-takes the fullscreen surface: the flush
                    // left the alternate screen, and a desynced ownership flag would make
                    // the exit-time leave a silent no-op while fullscreen frames paint the
                    // main screen.
                    if let Err(error) = crate::altscreen::enter() {
                        surface_error = Some(error);
                    }
                    let _ = crossterm::execute!(stdout(), crossterm::cursor::Hide);
                    if let Err(error) = terminal.clear() {
                        surface_error = surface_error.or_else(|| Some(anyhow::Error::new(error)));
                    }
                    match flushed {
                        Ok(true) => scrolled_scrollback = true,
                        Ok(false) => {}
                        Err(error) => {
                            surface_error =
                                surface_error.or_else(|| Some(anyhow::Error::new(error)));
                        }
                    }
                }
                Err(error) => surface_error = Some(error),
            }
            scrollback_flush_error = surface_error;
        }
    }
    // The hardware cursor is positioned at the focused caret for IME on every frame, but only
    // shown when `showHardwareCursor` is on. ratatui's `set_cursor_position` shows the cursor
    // unconditionally, so it may carry the caret only in the show case — the hidden case would
    // leave the terminal's own cursor visible while later paints drag it across every changed row.
    let show_hardware_cursor = view.show_hardware_cursor;
    let painted = terminal.draw(|f| {
        let lines: Vec<ratatui::text::Line<'static>> =
            frame.iter().map(crate::markdown::to_ratatui_line).collect();
        f.render_widget(ratatui::text::Text::from(lines), frame_area);
        if show_hardware_cursor {
            if let Some((row, col)) = cursor {
                if row < height && col < width {
                    f.set_cursor_position(ratatui::layout::Position::new(col as u16, row as u16));
                }
            }
        }
    });
    // The hidden case still positions: IME candidates anchor at the caret whether or not it
    // is visible. The bare MoveTo rides the same sync bracket, after the paint.
    if !show_hardware_cursor {
        if let Some((row, col)) = cursor {
            if row < height && col < width {
                use crossterm::cursor::MoveTo;
                crossterm::queue!(stdout(), MoveTo(col as u16, row as u16))?;
            }
        }
    }
    // Always release the terminal's pending update, including on paint errors.
    crossterm::execute!(stdout(), terminal::EndSynchronizedUpdate)?;
    painted?;
    if mounting {
        // Mode setup flushes stdout, so it must follow the completed first paint.
        crate::enhanced_keys::enable(&mut stdout())?;
    }
    Ok(Painted {
        scrollback_flush_error,
        scrolled_scrollback,
    })
}

/// Render one frame as plain text (the headless structural dump the tmux verifier and diff
/// tests use). ANSI styling and OSC zone markers are stripped.
pub fn render_frame_text(view: &mut AgentView, width: u16, height: u16) -> Vec<String> {
    let frame = view.render_frame(width as usize, height as usize);
    frame
        .iter()
        .map(|line| {
            let mut stripped = line.clone();
            crate::osc133::strip(&mut stripped);
            crate::hyperlinks::strip_osc8(&mut stripped);
            stripped.iter().map(|s| s.content.as_str()).collect()
        })
        .collect()
}
