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
//!
//! Every chunk then flows through the TS enhanced-key dispatch filters
//! (see [`filter_enhanced_key_events`]): key releases are dropped (TS
//! tui.ts dispatch filter) and a duplicate-reporting kitty terminal's
//! raw-text twin of a plain CSI-u character is deduplicated (TS
//! StdinBuffer `pendingKittyPrintableCodepoint`, stdin-buffer.ts:307).

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
/// lose a coalesced burst they cannot consume). Every chunk — one
/// terminal write — flows through [`filter_enhanced_key_events`] (the TS
/// release-event dispatch filter and the kitty-printable dedup) before it
/// reaches the surface, in TS order: the raw-paste heuristic sees the
/// untouched chunk first.
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
                            if paste_aware {
                                match printable_text(&event) {
                                    Some(chunk) => text.push_str(&chunk),
                                    None => burst_is_plain_text = false,
                                }
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
                if paste_aware && burst_is_plain_text && is_raw_multiline_paste(&text) {
                    if !on_input(ReaderInput::BurstPaste(text)) {
                        return;
                    }
                    continue;
                }
                for event in filter_enhanced_key_events(events) {
                    if !on_input(ReaderInput::Event(event)) {
                        return;
                    }
                }
            }
            Err(_) => break,
        }
    });
    *previous = Some(Reader { handle, stop });
}

/// The TS enhanced-key dispatch filters, applied to one terminal write:
///
/// - Key releases are dropped before any surface sees them (TS tui.ts:
///   `isKeyRelease(data) && !focusedComponent.wantsKeyRelease` — the only
///   TS opt-ins are example extensions, which this port does not ship).
/// - The kitty-printable dedup (TS StdinBuffer
///   `pendingKittyPrintableCodepoint`, stdin-buffer.ts:307): a
///   duplicate-reporting kitty terminal sends BOTH the plain CSI-u form
///   and the raw character for one keypress (Italian-style layouts, TS
///   #3780). crossterm folds both encodings into the same unmodified
///   `Char` key event, so the raw-text duplicate cannot be told from a
///   typed duplicate at the event layer; the port therefore drops an
///   identical back-to-back plain-character pair — but only within one
///   terminal write (a real keypress report never spans writes) and only
///   while the kitty protocol is active (a plain-typed pair in legacy
///   terminals never carries the CSI-u form, so TS never dedups it).
///
/// The pending state is chunk-local where TS keeps it across `process`
/// calls: TS sets it only from actual CSI-u forms, which this layer
/// cannot observe, so a cross-chunk pending would eat a fast-typed
/// double character instead.
fn filter_enhanced_key_events(events: Vec<Event>) -> Vec<Event> {
    if !crate::enhanced_keys::kitty_active() {
        return events
            .into_iter()
            .filter(|event| !is_key_release(event))
            .collect();
    }
    let mut out = Vec::with_capacity(events.len());
    let mut pending: Option<char> = None;
    for event in events {
        if is_key_release(&event) {
            // Dropped at dispatch (TS tui.ts), and it also clears the
            // pending: TS's emitDataSequence overwrites the pending with
            // undefined for every emitted non-matching sequence, so the
            // release form (`CSI 97;1:3u` — modifier section present)
            // never keeps a dedup alive.
            pending = None;
            continue;
        }
        let plain_press = plain_press_char(&event);
        if plain_press.is_some_and(|c| pending == Some(c)) {
            // The raw-text duplicate of the CSI-u form (one keypress).
            pending = None;
            continue;
        }
        pending = plain_press;
        out.push(event);
    }
    out
}

/// A key release event (kitty event type 3; TS tui.ts drops them at
/// dispatch unless the focused component opts in).
fn is_key_release(event: &Event) -> bool {
    matches!(
        event,
        Event::Key(key) if key.kind == KeyEventKind::Release
    )
}

/// The event shape the kitty CSI-u plain-printable form and its raw-text
/// duplicate both parse to: an unmodified character press (the TS
/// `parseUnmodifiedKittyPrintableCodepoint` regex admits only
/// modifier-free, event-type-free sequences, so lock states — which ride
/// the modifier mask — never join the dedup).
fn plain_press_char(event: &Event) -> Option<char> {
    let Event::Key(key) = event else {
        return None;
    };
    if key.kind != KeyEventKind::Press || !key.modifiers.is_empty() || !key.state.is_empty() {
        return None;
    }
    match key.code {
        KeyCode::Char(c) => Some(c),
        _ => None,
    }
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

    fn press(c: char) -> Event {
        Event::Key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE))
    }

    fn key_with_kind(code: KeyCode, modifiers: KeyModifiers, kind: KeyEventKind) -> Event {
        Event::Key(KeyEvent::new_with_kind(code, modifiers, kind))
    }

    /// Key releases never reach a surface (TS tui.ts: the focused
    /// component must opt in with wantsKeyRelease; no TS surface except
    /// example extensions does).
    #[test]
    fn key_releases_are_dropped_in_both_kitty_modes() {
        let release = key_with_kind(
            KeyCode::Char('a'),
            KeyModifiers::NONE,
            KeyEventKind::Release,
        );
        let up_release = key_with_kind(KeyCode::Up, KeyModifiers::NONE, KeyEventKind::Release);
        let ctrl_c_release = key_with_kind(
            KeyCode::Char('c'),
            KeyModifiers::CONTROL,
            KeyEventKind::Release,
        );
        let chunk = vec![press('a'), release, up_release, ctrl_c_release, press('b')];
        let filtered = filter_enhanced_key_events(chunk);
        let ids: Vec<String> = filtered
            .iter()
            .map(|event| {
                let Event::Key(key) = event else {
                    unreachable!()
                };
                crate::keys::key_event_to_id(key).unwrap()
            })
            .collect();
        assert_eq!(ids, vec!["a", "b"]);
    }

    /// The kitty-printable dedup (TS #3780): a duplicate-reporting kitty
    /// terminal sends `CSI 97u` followed by the raw character for ONE
    /// keypress; crossterm parses both to the same unmodified Char
    /// press, so the pair collapses to one. Identical back-to-back
    /// pairs keep TS's pending semantics: after a drop the pending
    /// clears, so a triple renders as two (never one, never three).
    #[test]
    fn kitty_printable_duplicates_collapse_within_a_chunk() {
        let _guard = crate::enhanced_keys::TEST_STATE_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        crate::enhanced_keys::set_kitty_active_for_tests(true);
        // `CSI 64u` + `@` (the TS regression case): one press.
        let filtered = filter_enhanced_key_events(vec![press('@'), press('@')]);
        assert_eq!(filtered.len(), 1);
        // A triple (`CSI 97u a a`): pending clears after the drop, so
        // two presses survive.
        let triple = filter_enhanced_key_events(vec![press('a'), press('a'), press('a')]);
        assert_eq!(triple.len(), 2);
        // A non-matching char after the CSI-u form is kept (TS: the
        // pending only matches the same codepoint).
        let mixed = filter_enhanced_key_events(vec![press('a'), press('b')]);
        assert_eq!(mixed.len(), 2);
        // A modified press never joins the dedup (TS: the regex admits
        // only modifier-free sequences — `CSI 97;5u` is ctrl+a).
        let modified_then_plain = filter_enhanced_key_events(vec![
            key_with_kind(
                KeyCode::Char('a'),
                KeyModifiers::CONTROL,
                KeyEventKind::Press,
            ),
            press('a'),
        ]);
        assert_eq!(modified_then_plain.len(), 2);
        // A repeat event (`CSI 97;1:2u`) overwrites the pending (TS: the
        // regex has no modifier/event-type section), so the raw char
        // after it is kept.
        let repeat = key_with_kind(KeyCode::Char('a'), KeyModifiers::NONE, KeyEventKind::Repeat);
        let after_repeat = filter_enhanced_key_events(vec![press('a'), repeat, press('a')]);
        assert_eq!(after_repeat.len(), 3);
        // A release between the pair breaks it (releases are dropped,
        // the pending never spans them).
        let release = key_with_kind(
            KeyCode::Char('a'),
            KeyModifiers::NONE,
            KeyEventKind::Release,
        );
        let spanned = filter_enhanced_key_events(vec![press('a'), release, press('a')]);
        assert_eq!(spanned.len(), 2);
        // Lock states ride the modifier mask in CSI-u (`CSI 97;65u`):
        // TS never dedups them.
        let caps_lock = Event::Key(KeyEvent {
            code: KeyCode::Char('a'),
            modifiers: KeyModifiers::NONE,
            kind: KeyEventKind::Press,
            state: crossterm::event::KeyEventState::CAPS_LOCK,
        });
        let with_caps = filter_enhanced_key_events(vec![caps_lock, press('a')]);
        assert_eq!(with_caps.len(), 2);
        crate::enhanced_keys::set_kitty_active_for_tests(false);
    }

    /// Without the kitty protocol the dedup is off: a plain terminal's
    /// identical pair is real input (TS never sees a CSI-u form to set
    /// the pending in legacy mode).
    #[test]
    fn plain_terminals_keep_identical_pairs() {
        let _guard = crate::enhanced_keys::TEST_STATE_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        crate::enhanced_keys::set_kitty_active_for_tests(false);
        let filtered = filter_enhanced_key_events(vec![press('a'), press('a')]);
        assert_eq!(filtered.len(), 2);
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
