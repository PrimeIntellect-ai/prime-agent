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
use crossterm::terminal::{self, EnterAlternateScreen, LeaveAlternateScreen};
use ratatui::{Terminal, TerminalOptions, Viewport};
use std::io::stdout;
use std::time::Duration;

pub struct AppOptions {
    pub theme: String,
    /// Replay delay per entry while streaming history (ms). 0 = instant load.
    pub replay_delay_ms: u64,
    /// Auto-exit after this many ms of runtime (headless verification).
    pub auto_exit_ms: Option<u64>,
}

impl Default for AppOptions {
    fn default() -> Self {
        Self {
            theme: "prime".to_string(),
            replay_delay_ms: 0,
            auto_exit_ms: None,
        }
    }
}

pub fn load_theme(name: &str) -> Theme {
    let mode = crate::theme::detect_color_mode();
    // The default brand theme when the caller passes none (empty) or an
    // unknown name; only known builtins resolve.
    let known = ["prime", "dark", "light"];
    let name = if known.contains(&name) { name } else { "prime" };
    Theme::builtin(name, mode)
}

/// Run the view against a session stream until the stream ends and the user
/// exits. `on_submit` receives editor submissions (unused in replay mode).
pub fn run_app(
    mut stream: Box<dyn SessionStream>,
    options: AppOptions,
    mut on_submit: Box<dyn FnMut(&str) + Send>,
) -> Result<()> {
    // The TS theme emits raw ANSI color codes regardless of NO_COLOR; match
    // that so the same terminal renders the same frames either way.
    crossterm::style::force_color_output(true);
    terminal::enable_raw_mode()?;
    crossterm::execute!(stdout(), EnterAlternateScreen)?;
    // The replay surface owns the same enhanced-key modes as the session
    // (TS `ProcessTerminal.start`): bracketed pastes arrive as one chunk.
    crate::enhanced_keys::enable(&mut std::io::stdout())?;
    let mut terminal = Terminal::new(crate::hyperlinks::stdout_backend())?;

    let theme = load_theme(&options.theme);
    let mut view = AgentView::new(theme);
    let mut running = true;
    let start = std::time::Instant::now();
    let mut stream_ended = false;

    loop {
        // Drain stream events.
        if !stream_ended {
            match stream.poll()? {
                SessionEvent::Item(item) => {
                    if let crate::session::TranscriptItem::ModelChange { model_id, .. } = &item {
                        view.chrome.model_id = Some(model_id.clone());
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
        draw(&mut terminal, &mut view)?;

        // Input.
        let timeout = Duration::from_millis(if stream_ended { 50 } else { 5 });
        if crossterm::event::poll(timeout)? {
            match crossterm::event::read()? {
                Event::Key(key) => {
                    handle_key(&mut view, key, &mut running, &mut *on_submit);
                    // The replay surface handles one key per loop turn, so
                    // a parked suggestion request materializes right after
                    // its key (the interactive loop batches; see
                    // `Editor::materialize_autocomplete`).
                    view.editor.materialize_autocomplete();
                    let _ = view.editor.take_events();
                }
                Event::Paste(text) => {
                    view.editor.handle_paste(&text);
                }
                Event::Resize(_, _) => {}
                _ => {}
            }
        }

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

    let mut out = stdout();
    let _ = crate::enhanced_keys::disable(&mut out);
    terminal::disable_raw_mode()?;
    crossterm::execute!(stdout(), LeaveAlternateScreen)?;
    Ok(())
}

fn handle_key(
    view: &mut AgentView,
    key: KeyEvent,
    running: &mut bool,
    on_submit: &mut dyn FnMut(&str),
) {
    // App-level bindings (coding-agent keybindings.ts):
    // ctrl+c exits the app shell in replay mode; escape cancels autocomplete.
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
        // Ctrl+O cycles conversation detail (TS `app.tools.expand`):
        // overview -> details -> all -> overview.
        view.detail = view.detail.next();
        return;
    }
    let Some(id) = key_event_to_id(&key) else {
        return;
    };
    // Transcript viewport keys (TS tui.ts consumes them before the editor
    // in fullscreen): page scroll, top, follow.
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
            EditorEvent::Changed(_) | EditorEvent::AutocompleteToggled(_) => {}
        }
    }
}

pub(crate) fn draw(
    terminal: &mut Terminal<crate::hyperlinks::LinkBackend>,
    view: &mut AgentView,
) -> Result<()> {
    let area = terminal.size()?;
    let frame_area = ratatui::layout::Rect::new(0, 0, area.width, area.height);
    let width = area.width as usize;
    let height = area.height as usize;
    let frame = view.render_frame(width, height);
    let cursor = view.frame_cursor();
    // The frame's embedded OSC 8 sequences drive the paint backend's
    // hyperlink injection; install the row/column ranges before the draw
    // (which strips the sequences from the painted cells).
    crate::hyperlinks::install_frame(&frame);
    // Zone markers ride on the composed rows; plan their emission before
    // the cell paint (which strips them), then write the sequences at their
    // rows after the frame is painted.
    let emissions = view.take_osc_emissions(&frame);
    terminal.draw(|f| {
        let lines: Vec<ratatui::text::Line<'static>> =
            frame.iter().map(crate::markdown::to_ratatui_line).collect();
        f.render_widget(ratatui::text::Text::from(lines), frame_area);
        if let Some((row, col)) = cursor {
            if row < height && col < width {
                f.set_cursor_position(ratatui::layout::Position::new(col as u16, row as u16));
            }
        }
    })?;
    emit_zone_markers(&emissions, cursor)?;
    Ok(())
}

/// Write OSC 133 zone-marker sequences at their frame rows. The sequences
/// are zero-width: the grid content is untouched and only the row flags the
/// terminal shell-integration reads change. The frame cursor is restored
/// afterwards (the marker writes move it).
fn emit_zone_markers(
    emissions: &[(usize, crate::osc133::RowMarkers)],
    cursor: Option<(usize, usize)>,
) -> Result<()> {
    if emissions.is_empty() {
        return Ok(());
    }
    use crossterm::cursor::MoveTo;
    use std::io::Write;
    let mut out = stdout();
    for (row, markers) in emissions {
        crossterm::queue!(out, MoveTo(0, *row as u16))?;
        if markers.start {
            out.write_all(crate::osc133::ZONE_START.as_bytes())?;
        }
        if markers.end {
            out.write_all(crate::osc133::ZONE_END.as_bytes())?;
            out.write_all(crate::osc133::ZONE_FINAL.as_bytes())?;
        }
    }
    if let Some((row, col)) = cursor {
        crossterm::queue!(out, MoveTo(col as u16, row as u16))?;
    }
    out.flush()?;
    Ok(())
}

/// Render one frame as plain text (headless structural dump used by the tmux
/// verifier and diff tests). ANSI styling and OSC zone markers are stripped.
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

#[allow(dead_code)]
fn unused(_: TerminalOptions, _: Viewport) {}
