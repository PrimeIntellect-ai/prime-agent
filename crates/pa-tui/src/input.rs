//! One crossterm input reader per process at a time.
//!
//! TUI surfaces hand the terminal to each other inside one process: the
//! agents-view loop opens chat sessions and reopens the view, and `/resume`
//! chains open one session after another. crossterm events are process
//! global, so two concurrent reader threads race for the same bytes; the
//! losing (older) thread can read a keypress after its channel is gone and
//! drop it — the user's key vanishes. [`spawn_terminal_reader`] joins the
//! still-running reader from the previous surface before starting the next
//! one, so exactly one reader is alive at any time.
//!
//! [`spawn_paste_aware_reader`] layers the TS `StdinBuffer` raw-paste
//! heuristic on top for the editor-bearing session surface: a keystroke
//! burst that arrives in one chunk shaped like multi-line text (text,
//! newline, text — tmux 3.2 and older forward pastes without bracketed
//! markers) is coalesced into one paste instead of submitting line by
//! line. A zero-timeout poll after each read marks the chunk boundary:
//! crossterm serves the rest of the same OS read without blocking, so a
//! burst is exactly the events one terminal write carried.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers};

struct Reader {
    handle: std::thread::JoinHandle<()>,
    stop: Arc<AtomicBool>,
}

/// The reader of the previous TUI surface in this process, if any.
static PREVIOUS_READER: Mutex<Option<Reader>> = Mutex::new(None);

/// TS's event loop reads stdin edge-driven (a single `poll`-like wait per
/// event); the Rust reader polls at this tick instead. The tick is also
/// the worst-case latency of the reader handoff: a surface switch stops
/// the previous reader's poll flag and joins it, and the join can only
/// return when the in-flight poll expires — so 100ms here read as a
/// ~50-100ms lag on every chat->agents switch. 10ms keeps idle wakeups
/// cheap (one `poll` syscall per tick) while bounding the handoff.
const POLL_TIMEOUT_MS: u64 = 10;

/// Ask the previous surface's reader to stop without joining it: the
/// handoff path flags the reader at teardown, so the flag is already set
/// (and the thread usually gone) by the time the next surface's
/// [`spawn_terminal_reader`] joins it. This keeps the switch off the
/// join's worst-case poll-tick wait and closes the window where a dying
/// reader could still steal a keypress aimed at the new surface.
pub(crate) fn request_reader_stop() {
    let guard = PREVIOUS_READER
        .lock()
        .expect("the input-reader registry lock is poisoned");
    if let Some(reader) = guard.as_ref() {
        reader.stop.store(true, Ordering::Relaxed);
    }
}

/// One input unit for the paste-aware reader: a parsed terminal event, or
/// a coalesced marker-less keystroke burst (the TS raw multiline-paste
/// heuristic; the payload keeps the burst's Enter keys as `\n`).
pub(crate) enum ReaderInput {
    Event(Event),
    BurstPaste(String),
}

/// Start the terminal input reader. `on_event` runs for every crossterm
/// event; returning `false` stops the reader (the caller stops it when its
/// channel dies). The reader from the previous surface is stopped and joined
/// first so it cannot steal events from the new one.
pub(crate) fn spawn_terminal_reader<F>(mut on_event: F)
where
    F: FnMut(Event) -> bool + Send + 'static,
{
    spawn_reader(false, move |input| match input {
        ReaderInput::Event(event) => on_event(event),
        ReaderInput::BurstPaste(_) => true,
    });
}

/// The paste-aware variant for the interactive session surface: whole
/// terminal writes that look like multi-line pastes (a marker-less burst
/// with text on both sides of a newline) are delivered as one
/// [`ReaderInput::BurstPaste`]; everything else arrives event by event.
pub(crate) fn spawn_paste_aware_reader<F>(on_input: F)
where
    F: FnMut(ReaderInput) -> bool + Send + 'static,
{
    spawn_reader(true, on_input);
}

/// The shared reader body: one reader per process, joined across surfaces.
/// `paste_aware` selects the burst coalescing; a plain reader forwards
/// every event unchanged (surfaces without the editor's paste path would
/// lose a coalesced burst they cannot consume).
fn spawn_reader<F>(paste_aware: bool, mut on_input: F)
where
    F: FnMut(ReaderInput) -> bool + Send + 'static,
{
    let mut previous = PREVIOUS_READER
        .lock()
        .expect("the input-reader registry lock is poisoned");
    if let Some(reader) = previous.take() {
        reader.stop.store(true, Ordering::Relaxed);
        let _ = reader.handle.join();
    }
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let handle = std::thread::spawn(move || loop {
        if thread_stop.load(Ordering::Relaxed) {
            break;
        }
        match crossterm::event::poll(Duration::from_millis(POLL_TIMEOUT_MS)) {
            Ok(false) => continue,
            Ok(true) => {
                if !paste_aware {
                    match crossterm::event::read() {
                        Ok(event) => {
                            if !on_input(ReaderInput::Event(event)) {
                                return;
                            }
                        }
                        Err(_) => return,
                    }
                    continue;
                }
                // Drain every event of this terminal write: a zero-timeout
                // poll serves the rest of the same OS read without
                // blocking, so the drain stops exactly at the chunk
                // boundary.
                let mut events = Vec::new();
                let mut text = String::new();
                let mut burst_is_plain_text = true;
                loop {
                    match crossterm::event::read() {
                        Ok(event) => {
                            match printable_text(&event) {
                                Some(chunk) => text.push_str(&chunk),
                                None => burst_is_plain_text = false,
                            }
                            events.push(event);
                            match crossterm::event::poll(Duration::ZERO) {
                                Ok(true) => continue,
                                _ => break,
                            }
                        }
                        Err(_) => return,
                    }
                }
                if burst_is_plain_text && is_raw_multiline_paste(&text) {
                    if !on_input(ReaderInput::BurstPaste(text)) {
                        return;
                    }
                } else {
                    for event in events {
                        if !on_input(ReaderInput::Event(event)) {
                            return;
                        }
                    }
                }
            }
            Err(_) => break,
        }
    });
    *previous = Some(Reader { handle, stop });
}

/// The plain-text contribution of one event for a marker-less burst: the
/// bytes a paste carries, reconstructed for the editor's paste filter.
/// Enter is `\r` and Ctrl+letters are their control bytes, so the payload
/// byte-matches the terminal stream and `normalize_text` folds CRLF/CR the
/// same way the TS editor does. Anything else — mouse reports, resize,
/// escape sequences, alt/shift-modified keys, key releases — marks the
/// burst as not a raw paste (TS `isRawMultilinePaste` bails on any escape
/// byte).
fn printable_text(event: &Event) -> Option<String> {
    let Event::Key(key) = event else {
        return None;
    };
    if !matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) {
        return None;
    }
    let alt_or_meta = key.modifiers.intersects(
        KeyModifiers::ALT | KeyModifiers::SUPER | KeyModifiers::HYPER | KeyModifiers::META,
    );
    if alt_or_meta {
        return None;
    }
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let shift = key.modifiers.contains(KeyModifiers::SHIFT);
    match key.code {
        KeyCode::Char(c) => {
            if ctrl {
                // The Ctrl+letter key IS the control byte a pasted stream
                // carries (LF is Ctrl+J); the editor's paste filter drops
                // the non-newline ones, TS parity.
                if c.is_ascii_lowercase() {
                    char::from_u32(u32::from(c) - 96).map(String::from)
                } else if c.is_ascii_uppercase() {
                    char::from_u32(u32::from(c) - 64).map(String::from)
                } else {
                    None
                }
            } else if !shift || c.is_uppercase() {
                Some(c.to_string())
            } else {
                None
            }
        }
        KeyCode::Enter if !ctrl && !shift => Some("\r".to_string()),
        KeyCode::Tab if !ctrl && !shift => Some("\t".to_string()),
        _ => None,
    }
}

/// TS `isRawMultilinePaste`: the chunk must carry text on both sides of a
/// newline run — a leading or trailing Enter alone is ordinary key input,
/// not evidence of a multi-line paste.
fn is_raw_multiline_paste(text: &str) -> bool {
    let is_newline = |c: char| c == '\n' || c == '\r';
    let chars: Vec<char> = text.chars().collect();
    let mut newline_run_start: Option<usize> = None;
    for (index, &c) in chars.iter().enumerate() {
        if is_newline(c) {
            if newline_run_start.is_none() {
                newline_run_start = Some(index);
            }
        } else {
            // A non-newline after a run that follows a non-newline closes
            // the match.
            if let Some(run) = newline_run_start {
                if run > 0 {
                    return true;
                }
                newline_run_start = None;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};

    fn key(code: KeyCode, modifiers: KeyModifiers) -> Event {
        Event::Key(KeyEvent::new(code, modifiers))
    }

    #[test]
    fn printable_text_reconstructs_the_pasted_bytes() {
        use KeyModifiers as M;
        // Plain characters (typed and pasted).
        assert_eq!(
            printable_text(&key(KeyCode::Char('a'), M::NONE)),
            Some("a".into())
        );
        assert_eq!(
            printable_text(&key(KeyCode::Char('A'), M::SHIFT)),
            Some("A".into())
        );
        // Enter is CR and Tab is TAB: the editor's paste filter folds them.
        assert_eq!(
            printable_text(&key(KeyCode::Enter, M::NONE)),
            Some("\r".into())
        );
        assert_eq!(
            printable_text(&key(KeyCode::Tab, M::NONE)),
            Some("\t".into())
        );
        // Ctrl+letters are the control bytes of the stream (LF is Ctrl+J);
        // handle_paste drops the non-newline ones, TS parity.
        assert_eq!(
            printable_text(&key(KeyCode::Char('j'), M::CONTROL)),
            Some("\n".into())
        );
        assert_eq!(
            printable_text(&key(KeyCode::Char('I'), M::CONTROL)),
            Some("\t".into())
        );
    }

    #[test]
    fn printable_text_rejects_non_paste_keys() {
        use KeyModifiers as M;
        // Modified and special keys never join a paste burst.
        assert_eq!(printable_text(&key(KeyCode::Enter, M::SHIFT)), None);
        assert_eq!(printable_text(&key(KeyCode::Char('a'), M::ALT)), None);
        assert_eq!(printable_text(&key(KeyCode::Char('a'), M::SHIFT)), None);
        assert_eq!(printable_text(&key(KeyCode::Left, M::CONTROL)), None);
        assert_eq!(printable_text(&key(KeyCode::Esc, M::NONE)), None);
        // Mouse and resize events break the burst (TS bails on any ESC).
        assert_eq!(printable_text(&Event::Resize(80, 24)), None);
    }

    #[test]
    fn multiline_shape_needs_text_on_both_sides() {
        assert!(is_raw_multiline_paste("alpha\nbeta\ngamma"));
        assert!(is_raw_multiline_paste("alpha\n\n\nbeta"));
        assert!(is_raw_multiline_paste("a\nb\n"));
        // CR from the terminal and CRLF chunks fold the same way.
        assert!(is_raw_multiline_paste("alpha\rbeta"));
        assert!(is_raw_multiline_paste("alpha\r\nbeta"));
        // A lone Enter — even several — is ordinary key input.
        assert!(!is_raw_multiline_paste("\n"));
        assert!(!is_raw_multiline_paste("alpha\n"));
        assert!(!is_raw_multiline_paste("\nalpha"));
        assert!(!is_raw_multiline_paste("alpha"));
        assert!(!is_raw_multiline_paste(""));
    }
}
