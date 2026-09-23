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
//! Both readers also run the [`SequenceGuard`] (TS `StdinBuffer`'s
//! partial-sequence hold, ported in [`crate::sequence_guard`]):
//! crossterm's parser commits a lone trailing `ESC` at every partial-read
//! boundary, and the sequence it opened then arrives as plain `Char`
//! presses — a mouse drag types SGR report bodies into the editor. The
//! guard holds that `ESC`, reassembles the sequence, and hands the reader
//! decoded mouse reports and consumed escape forms instead.
//!
//! Every chunk then flows through the TS enhanced-key dispatch filters
//! (see [`filter_enhanced_key_events`]): key releases are dropped (TS
//! tui.ts dispatch filter) and a duplicate-reporting kitty terminal's
//! raw-text twin of a plain CSI-u character is deduplicated (TS
//! StdinBuffer `pendingKittyPrintableCodepoint`, stdin-buffer.ts:307).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::sequence_guard::{GuardOutput, SequenceGuard};

use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

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

/// One input unit for the paste-aware reader: a parsed terminal event, a
/// mouse report decoded from a reassembled escape sequence, or a
/// coalesced marker-less keystroke burst (the TS raw multiline-paste
/// heuristic; the payload keeps the burst's Enter keys as `\n`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ReaderInput {
    Event(Event),
    Mouse(crate::mouse::MouseEvent),
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
        // Surfaces without a mouse dispatch consume reports; a
        // reassembled report is terminal noise they must not type.
        ReaderInput::Mouse(_) => true,
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
/// lose a coalesced burst they cannot consume). Each chunk — one
/// terminal write — is repaired and classified before any of it reaches
/// the surface: the macOS-Terminal meta repair
/// ([`merge_legacy_meta_escapes`]) rewrites the wrapped double-ESC
/// shapes first (the [`SequenceGuard`] would otherwise hold their `Esc`
/// head), the guard reassembles partial sequences into mouse reports
/// and key events, and [`forward`] passes the TS dispatch filters
/// ([`filter_enhanced_key_events`]) when it delivers.
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
    let handle = std::thread::spawn(move || {
        let mut guard = SequenceGuard::default();
        loop {
            if thread_stop.load(Ordering::Relaxed) {
                break;
            }
            // The wait never runs past a held escape sequence's deadline:
            // the guard flushes on the next wake.
            let timeout =
                guard.poll_timeout(Duration::from_millis(POLL_TIMEOUT_MS), Instant::now());
            match crossterm::event::poll(timeout) {
                Ok(false) => {
                    if !forward(
                        guard.flush_expired(Instant::now()),
                        paste_aware,
                        &mut on_input,
                    ) {
                        return;
                    }
                }
                Ok(true) => {
                    // Drain every event of this terminal write: a
                    // zero-timeout poll serves the rest of the same OS read
                    // without blocking, so the drain stops exactly at the
                    // chunk boundary.
                    let mut events = Vec::new();
                    loop {
                        match crossterm::event::read() {
                            Ok(event) => {
                                events.push(event);
                                match crossterm::event::poll(Duration::ZERO) {
                                    Ok(true) => continue,
                                    _ => break,
                                }
                            }
                            Err(_) => return,
                        }
                    }
                    // The meta repair runs on the raw chunk, BEFORE the
                    // guard: a wrapped `ESC ESC [ A` folds to `Esc` +
                    // `[` + SHIFT-ed letter, and the guard would hold the
                    // wrapper's `Esc` head and reassemble the inner
                    // `ESC [ A` as plain Up — the option identity TS's
                    // double-ESC branch (keys.ts:788) rebuilds would be
                    // lost. The repaired Alt+key is never a bare Esc
                    // press, so the guard never holds it, and the partial
                    // sequences the guard exists for end their write on
                    // the lone `Esc` with no decodable body beside it,
                    // so the repair never steals one either.
                    let events = merge_legacy_meta_escapes(events);
                    let mut outputs = Vec::new();
                    for event in events {
                        outputs.extend(guard.feed(event, Instant::now()));
                    }
                    if !forward(outputs, paste_aware, &mut on_input) {
                        return;
                    }
                }
                Err(_) => break,
            }
        }
    });
    *previous = Some(Reader { handle, stop });
}

/// Deliver one drained round to the surface: a whole-write burst that
/// reconstructs to marker-less multi-line text coalesces into one
/// [`ReaderInput::BurstPaste`] (the TS raw-paste heuristic); everything
/// else — plain events and reassembled mouse reports alike — passes the
/// TS dispatch filters ([`filter_enhanced_key_events`]) and forwards
/// input by input. Returns `false` when the surface stopped the reader.
fn forward(
    outputs: Vec<GuardOutput>,
    paste_aware: bool,
    on_input: &mut dyn FnMut(ReaderInput) -> bool,
) -> bool {
    if paste_aware && !outputs.is_empty() {
        let mut text = String::new();
        let mut burst_is_plain_text = true;
        for output in &outputs {
            match output {
                GuardOutput::Event(event) => match printable_text(event) {
                    Some(chunk) => text.push_str(&chunk),
                    None => burst_is_plain_text = false,
                },
                // A reassembled report breaks the burst like the mouse
                // events crossterm parses itself do.
                GuardOutput::Mouse(_) => burst_is_plain_text = false,
            }
        }
        if burst_is_plain_text && is_raw_multiline_paste(&text) {
            return on_input(ReaderInput::BurstPaste(text));
        }
    }
    // The dispatch filters run after the guard — a reassembled sequence
    // can complete mid-round, and its synthesized form must pass them
    // like an event crossterm parsed itself would (a split kitty release
    // form is dropped here too). Mouse reports keep their stream slots
    // between the filtered key runs.
    let mut inputs = Vec::with_capacity(outputs.len());
    let mut key_run: Vec<Event> = Vec::new();
    for output in outputs {
        match output {
            GuardOutput::Event(event) => key_run.push(event),
            GuardOutput::Mouse(report) => {
                inputs.extend(
                    filter_enhanced_key_events(std::mem::take(&mut key_run))
                        .into_iter()
                        .map(ReaderInput::Event),
                );
                inputs.push(ReaderInput::Mouse(report));
            }
        }
    }
    inputs.extend(
        filter_enhanced_key_events(key_run)
            .into_iter()
            .map(ReaderInput::Event),
    );
    for input in inputs {
        if !on_input(input) {
            return false;
        }
    }
    true
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

/// macOS-Terminal legacy-meta repair (TS `matchesKey`'s double-ESC branch,
/// keys.ts:788): with "use option as meta key" the terminal wraps the whole
/// sequence in an extra ESC — Option+Up arrives as `ESC ESC [ A`. crossterm
/// folds that byte stream into `Esc` + literal `[` + a SHIFT-ed letter (its
/// ESC branch consumes the second ESC and re-parses the rest byte by byte),
/// so the option identity is lost: the escape fires the interrupt ladder and
/// `[A` types into the editor. TS matches the wrapped form byte-wise (strip
/// "alt" from the key id, match the rest), so Option+Up browses the queue.
///
/// This pass rebuilds the wrapped identity from one terminal write's events:
/// an `Esc` press followed by `Char('[')`/`Char('O')` and a body that
/// reassembles into a known legacy CSI/SS3 sequence decodes back to the
/// inner key with ALT added. The shape cannot come from typed input (a
/// keypress never spans writes; ESC `[` letter as one write is exactly the
/// wrapped encoding), so the repair never steals a real escape press.
/// Inactive while the kitty protocol is active: those terminals report
/// option-modified keys natively and never send the double-ESC form. A tail
/// that does not decode stays untouched.
fn merge_legacy_meta_escapes(events: Vec<Event>) -> Vec<Event> {
    if crate::enhanced_keys::kitty_active() {
        return events;
    }
    let mut out: Vec<Event> = Vec::with_capacity(events.len());
    let mut index = 0;
    while index < events.len() {
        if !is_meta_escape_head(&events[index]) {
            out.push(events[index].clone());
            index += 1;
            continue;
        }
        let (consumed, repaired) = decode_meta_escape_body(&events[index + 1..]);
        match repaired {
            Some(mut key) => {
                key.modifiers |= KeyModifiers::ALT;
                out.push(Event::Key(key));
                index += 1 + consumed;
            }
            // Not a wrapped sequence: keep the escape (and re-scan the rest).
            None => {
                out.push(events[index].clone());
                index += 1;
            }
        }
    }
    out
}

/// The repair's head: a bare `Esc` press (the meta wrapper ESC; the inner
/// sequence's own bytes follow as folded `Char` events).
fn is_meta_escape_head(event: &Event) -> bool {
    matches!(event, Event::Key(key) if key.code == KeyCode::Esc
        && key.kind == KeyEventKind::Press
        && key.modifiers.is_empty())
}

/// Decode the wrapped body — the sequence's remaining bytes, which crossterm
/// folded into plain (symbols, digits) and SHIFT-synthesized (uppercase
/// letters) `Char` presses. Returns the consumed event count and the inner
/// key WITHOUT the meta ALT (the caller adds it); `None` when the tail is
/// not a known legacy sequence.
fn decode_meta_escape_body(rest: &[Event]) -> (usize, Option<KeyEvent>) {
    let mut body: Vec<char> = Vec::new();
    let mut consumed = 0;
    for event in rest {
        let Event::Key(key) = event else { break };
        if key.kind != KeyEventKind::Press {
            break;
        }
        let KeyCode::Char(c) = key.code else { break };
        if !key.modifiers.is_empty() && !key.modifiers.contains(KeyModifiers::SHIFT) {
            break;
        }
        body.push(c);
        consumed += 1;
        // SS3 closes on its one designator; CSI closes on a letter, `~`,
        // or the rxvt `$`/`^` modifier-designator final byte.
        if body[0] == 'O' && body.len() == 2 {
            break;
        }
        if body[0] == '['
            && body.len() >= 2
            && (c == '~' || c == '$' || c == '^' || c.is_ascii_alphabetic())
        {
            break;
        }
        if body.len() >= 16 {
            break;
        }
    }
    (consumed, decode_legacy_meta_sequence(&body))
}

/// The inner legacy sequence (`ESC` + the body): the same forms crossterm
/// parses natively without the wrapper, so the decoded identity matches the
/// unwrapped byte stream (TS strips the meta ESC and matches the rest).
fn decode_legacy_meta_sequence(body: &[char]) -> Option<KeyEvent> {
    let inner: String = std::iter::once('\x1b')
        .chain(body.iter().copied())
        .collect();
    let (code, modifiers) = match inner.as_str() {
        "\x1bOA" => (KeyCode::Up, KeyModifiers::NONE),
        "\x1bOB" => (KeyCode::Down, KeyModifiers::NONE),
        "\x1bOC" => (KeyCode::Right, KeyModifiers::NONE),
        "\x1bOD" => (KeyCode::Left, KeyModifiers::NONE),
        "\x1bOH" => (KeyCode::Home, KeyModifiers::NONE),
        "\x1bOF" => (KeyCode::End, KeyModifiers::NONE),
        // rxvt-style ctrl arrows over SS3 (TS keys.ts keys.ctrl map).
        "\x1bOa" => (KeyCode::Up, KeyModifiers::CONTROL),
        "\x1bOb" => (KeyCode::Down, KeyModifiers::CONTROL),
        "\x1bOc" => (KeyCode::Right, KeyModifiers::CONTROL),
        "\x1bOd" => (KeyCode::Left, KeyModifiers::CONTROL),
        "\x1bOP" => (KeyCode::F(1), KeyModifiers::NONE),
        "\x1bOQ" => (KeyCode::F(2), KeyModifiers::NONE),
        "\x1bOR" => (KeyCode::F(3), KeyModifiers::NONE),
        "\x1bOS" => (KeyCode::F(4), KeyModifiers::NONE),
        "\x1b[A" => (KeyCode::Up, KeyModifiers::NONE),
        "\x1b[B" => (KeyCode::Down, KeyModifiers::NONE),
        "\x1b[C" => (KeyCode::Right, KeyModifiers::NONE),
        "\x1b[D" => (KeyCode::Left, KeyModifiers::NONE),
        "\x1b[H" => (KeyCode::Home, KeyModifiers::NONE),
        "\x1b[F" => (KeyCode::End, KeyModifiers::NONE),
        "\x1b[Z" => (KeyCode::BackTab, KeyModifiers::NONE),
        "\x1b[2~" => (KeyCode::Insert, KeyModifiers::NONE),
        "\x1b[3~" => (KeyCode::Delete, KeyModifiers::NONE),
        "\x1b[5~" => (KeyCode::PageUp, KeyModifiers::NONE),
        "\x1b[6~" => (KeyCode::PageDown, KeyModifiers::NONE),
        "\x1b[7~" => (KeyCode::Home, KeyModifiers::NONE),
        "\x1b[8~" => (KeyCode::End, KeyModifiers::NONE),
        // rxvt-style shift+arrows over SS3-lite CSI (TS keys.ts
        // LEGACY_SHIFT_SEQUENCES) — Option+Shift+Up arrives meta-wrapped on
        // those terminals.
        "\x1b[a" => (KeyCode::Up, KeyModifiers::SHIFT),
        "\x1b[b" => (KeyCode::Down, KeyModifiers::SHIFT),
        "\x1b[c" => (KeyCode::Right, KeyModifiers::SHIFT),
        "\x1b[d" => (KeyCode::Left, KeyModifiers::SHIFT),
        "\x1b[2$" => (KeyCode::Insert, KeyModifiers::SHIFT),
        "\x1b[3$" => (KeyCode::Delete, KeyModifiers::SHIFT),
        "\x1b[5$" => (KeyCode::PageUp, KeyModifiers::SHIFT),
        "\x1b[6$" => (KeyCode::PageDown, KeyModifiers::SHIFT),
        "\x1b[7$" => (KeyCode::Home, KeyModifiers::SHIFT),
        "\x1b[8$" => (KeyCode::End, KeyModifiers::SHIFT),
        // rxvt-style ctrl-modified tilde finals (TS keys.ts
        // LEGACY_CTRL_SEQUENCES, the `$`/`^` complement rows).
        "\x1b[2^" => (KeyCode::Insert, KeyModifiers::CONTROL),
        "\x1b[3^" => (KeyCode::Delete, KeyModifiers::CONTROL),
        "\x1b[5^" => (KeyCode::PageUp, KeyModifiers::CONTROL),
        "\x1b[6^" => (KeyCode::PageDown, KeyModifiers::CONTROL),
        "\x1b[7^" => (KeyCode::Home, KeyModifiers::CONTROL),
        "\x1b[8^" => (KeyCode::End, KeyModifiers::CONTROL),
        _ => decode_csi_with_modifier(inner.strip_prefix("\x1b[")?)?,
    };
    Some(KeyEvent::new_with_kind(
        code,
        modifiers,
        KeyEventKind::Press,
    ))
}

/// `ESC [ 1;<m><final>` and `ESC [ <n>;<m>~` (the xterm modifier parameter,
/// m-1 a bitfield: 1 shift, 2 alt, 4 ctrl). The alt bit is the meta wrapper
/// itself, so only modifier values without it decode (1 plain, 2 shift,
/// 5 ctrl, 6 shift+ctrl) — with alt in the parameter TS's strip-and-match
/// never finds a key either. Kept to the finals the product binds.
fn decode_csi_with_modifier(rest: &str) -> Option<(KeyCode, KeyModifiers)> {
    let (params, last) = rest.split_once(';')?;
    if last.is_empty() {
        return None;
    }
    let (modifier, final_char) = last.split_at(last.chars().count() - 1);
    let modifiers = match modifier.parse::<u8>().ok()? {
        1 => KeyModifiers::NONE,
        2 => KeyModifiers::SHIFT,
        5 => KeyModifiers::CONTROL,
        6 => KeyModifiers::SHIFT | KeyModifiers::CONTROL,
        _ => return None,
    };
    let code = match final_char {
        "A" => KeyCode::Up,
        "B" => KeyCode::Down,
        "C" => KeyCode::Right,
        "D" => KeyCode::Left,
        "H" => KeyCode::Home,
        "F" => KeyCode::End,
        "~" => match params {
            "2" => KeyCode::Insert,
            "3" => KeyCode::Delete,
            "5" => KeyCode::PageUp,
            "6" => KeyCode::PageDown,
            _ => return None,
        },
        _ => return None,
    };
    Some((code, modifiers))
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
    fn a_reassembled_report_breaks_the_burst_like_a_parsed_mouse_event() {
        // The guard's decoded reports are terminal noise, never paste
        // evidence: the chars around them forward one by one.
        let report = crate::mouse::parse_sgr_mouse_event("\x1b[<32;14;2M").expect("valid report");
        let outputs = vec![
            GuardOutput::Event(key(KeyCode::Char('a'), KeyModifiers::NONE)),
            GuardOutput::Mouse(report),
            GuardOutput::Event(key(KeyCode::Enter, KeyModifiers::NONE)),
            GuardOutput::Event(key(KeyCode::Char('b'), KeyModifiers::NONE)),
        ];
        let inputs = collect_forwarded(outputs);
        assert_eq!(
            inputs,
            vec![
                ReaderInput::Event(key(KeyCode::Char('a'), KeyModifiers::NONE)),
                ReaderInput::Mouse(report),
                ReaderInput::Event(key(KeyCode::Enter, KeyModifiers::NONE)),
                ReaderInput::Event(key(KeyCode::Char('b'), KeyModifiers::NONE)),
            ]
        );
    }

    #[test]
    fn a_plain_multiline_char_burst_still_coalesces_into_a_paste() {
        let outputs = vec![
            GuardOutput::Event(key(KeyCode::Char('x'), KeyModifiers::NONE)),
            GuardOutput::Event(key(KeyCode::Enter, KeyModifiers::NONE)),
            GuardOutput::Event(key(KeyCode::Char('y'), KeyModifiers::NONE)),
        ];
        assert_eq!(
            collect_forwarded(outputs),
            vec![ReaderInput::BurstPaste("x\ry".into())]
        );
    }

    /// `forward` against a capturing sink (the paste-aware surface).
    fn collect_forwarded(outputs: Vec<GuardOutput>) -> Vec<ReaderInput> {
        let mut inputs = Vec::new();
        let ok = forward(outputs, true, &mut |input| {
            inputs.push(input);
            true
        });
        assert!(ok);
        inputs
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

    // --- legacy meta-escape repair (TS matchesKey's double-ESC branch) ---

    fn shift_press(c: char) -> Event {
        Event::Key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::SHIFT))
    }

    fn ids_of(events: &[Event]) -> Vec<String> {
        events
            .iter()
            .map(|event| match event {
                Event::Key(key) => {
                    crate::keys::key_event_to_id(key).unwrap_or_else(|| "<unmapped>".to_string())
                }
                other => format!("<{other:?}>"),
            })
            .collect()
    }

    /// macOS Terminal with "use option as meta key": Option+Up arrives as
    /// `ESC ESC [ A` - crossterm folds it into Esc + `[` + SHIFT-ed `A` in
    /// one write, and the repair rebuilds the Alt+Up identity (the TS
    /// strip-alt match), so the queue browse opens instead of the escape
    /// firing the interrupt ladder.
    #[test]
    fn wrapped_meta_escape_rebuilds_alt_arrows() {
        let _guard = crate::enhanced_keys::TEST_STATE_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        crate::enhanced_keys::set_kitty_active_for_tests(false);
        let merged = merge_legacy_meta_escapes(vec![
            Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
            press('['),
            shift_press('A'),
        ]);
        assert_eq!(ids_of(&merged), vec!["alt+up".to_string()]);

        let merged = merge_legacy_meta_escapes(vec![
            Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
            press('O'),
            shift_press('B'),
        ]);
        assert_eq!(ids_of(&merged), vec!["alt+down".to_string()]);
    }

    /// The xterm modifier parameter inside the wrapper: 1 plain, 2 shift,
    /// 5 ctrl, 6 shift+ctrl decode (TS's strip-alt match accepts exactly
    /// these); 3/4/7/8 carry the alt bit IN the parameter, which TS's
    /// stripped key id can never match, so the chunk stays untouched.
    #[test]
    fn wrapped_modifier_parameters_decode_like_ts() {
        let _guard = crate::enhanced_keys::TEST_STATE_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        crate::enhanced_keys::set_kitty_active_for_tests(false);
        let wrapped = |body: &[char]| {
            let mut events = vec![Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE))];
            for (index, c) in body.iter().enumerate() {
                let uppercase_last = index == body.len() - 1 && c.is_ascii_uppercase();
                events.push(if uppercase_last {
                    shift_press(*c)
                } else {
                    press(*c)
                });
            }
            merge_legacy_meta_escapes(events)
        };
        assert_eq!(ids_of(&wrapped(&['[', '1', ';', '1', 'A']))[0], "alt+up");
        assert_eq!(
            ids_of(&wrapped(&['[', '1', ';', '2', 'A']))[0],
            "shift+alt+up"
        );
        assert_eq!(
            ids_of(&wrapped(&['[', '1', ';', '5', 'A']))[0],
            "ctrl+alt+up"
        );
        assert_eq!(
            ids_of(&wrapped(&['[', '1', ';', '6', 'A']))[0],
            "shift+ctrl+alt+up"
        );
        // Alt-bit parameter values: TS matches nothing either - the escape
        // and the folded characters survive as-is.
        let untouched = wrapped(&['[', '1', ';', '3', 'A']);
        assert_eq!(untouched.len(), 6);
        assert!(matches!(untouched[0], Event::Key(ref k) if k.code == KeyCode::Esc));
    }

    /// rxvt-family rows inside the wrapper: shift+arrows (`\x1b[a`),
    /// ctrl+arrows over SS3 (`\x1bOa`), the `$`/`^` tilde complements, and
    /// the home/end alternates - the TS LEGACY_SHIFT/CTRL/KEY rows its
    /// strip-and-match still reaches through the wrapper.
    #[test]
    fn wrapped_rxvt_modifier_rows_decode() {
        let _guard = crate::enhanced_keys::TEST_STATE_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        crate::enhanced_keys::set_kitty_active_for_tests(false);
        let wrapped = |body: &[char]| {
            let mut events = vec![Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE))];
            for (index, c) in body.iter().enumerate() {
                let uppercase_last = index == body.len() - 1 && c.is_ascii_uppercase();
                events.push(if uppercase_last {
                    shift_press(*c)
                } else {
                    press(*c)
                });
            }
            merge_legacy_meta_escapes(events)
        };
        assert_eq!(ids_of(&wrapped(&['[', 'a']))[0], "shift+alt+up");
        assert_eq!(ids_of(&wrapped(&['[', 'd']))[0], "shift+alt+left");
        assert_eq!(ids_of(&wrapped(&['O', 'a']))[0], "ctrl+alt+up");
        assert_eq!(ids_of(&wrapped(&['[', '5', '$']))[0], "shift+alt+pageUp");
        assert_eq!(ids_of(&wrapped(&['[', '3', '^']))[0], "ctrl+alt+delete");
        assert_eq!(ids_of(&wrapped(&['[', '7', '~']))[0], "alt+home");
    }

    /// A real escape press is never stolen: a bare Esc, an Esc followed by
    /// typed text, and an incomplete tail all pass through unchanged (the
    /// wrapped shape - ESC `[` letter as ONE write - never comes from
    /// typing).
    #[test]
    fn typed_escapes_survive_the_repair() {
        let _guard = crate::enhanced_keys::TEST_STATE_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        crate::enhanced_keys::set_kitty_active_for_tests(false);
        let esc = Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(merge_legacy_meta_escapes(vec![esc.clone()]).len(), 1);
        let mixed = merge_legacy_meta_escapes(vec![esc.clone(), press('x')]);
        assert_eq!(ids_of(&mixed), vec!["escape".to_string(), "x".to_string()]);
        let incomplete = merge_legacy_meta_escapes(vec![esc.clone(), press('[')]);
        assert_eq!(incomplete.len(), 2);
        assert!(matches!(incomplete[0], Event::Key(ref k) if k.code == KeyCode::Esc));
    }

    /// Inactive under the kitty protocol: those terminals report
    /// option-modified keys natively and never send the double-ESC form.
    #[test]
    fn kitty_mode_disables_the_meta_repair() {
        let _guard = crate::enhanced_keys::TEST_STATE_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        crate::enhanced_keys::set_kitty_active_for_tests(true);
        let chunk = vec![
            Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
            press('['),
            shift_press('A'),
        ];
        assert_eq!(merge_legacy_meta_escapes(chunk).len(), 3);
        crate::enhanced_keys::set_kitty_active_for_tests(false);
    }

    // --- the merged seam: the meta repair runs before the sequence guard ---

    /// The wrapped Option+Up chunk is repaired BEFORE the guard sees it:
    /// the guard would otherwise hold the wrapper's `Esc` head, reassemble
    /// the inner `ESC [ A`, and synthesize plain Up — the option identity
    /// TS's double-ESC branch (keys.ts:788) rebuilds would be lost, and
    /// the queue browse would move the cursor instead.
    #[test]
    fn the_wrapped_meta_form_passes_the_guard_with_alt_kept() {
        let _state = crate::enhanced_keys::TEST_STATE_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        crate::enhanced_keys::set_kitty_active_for_tests(false);
        let write = vec![
            Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
            press('['),
            shift_press('A'),
        ];
        let mut guard = SequenceGuard::default();
        let now = Instant::now();
        let outputs: Vec<GuardOutput> = merge_legacy_meta_escapes(write)
            .into_iter()
            .flat_map(|event| guard.feed(event, now))
            .collect();
        assert_eq!(outputs.len(), 1, "one key, not a held head: {outputs:?}");
        let GuardOutput::Event(Event::Key(key)) = &outputs[0] else {
            panic!("the repaired form must deliver as a key event");
        };
        assert_eq!(key.code, KeyCode::Up);
        assert_eq!(key.modifiers, KeyModifiers::ALT);
        // The repaired Alt+Up is not a bare Esc press, so nothing is held.
        assert!(guard
            .flush_expired(now + crate::sequence_guard::HOLD)
            .is_empty());
    }

    /// The repair never steals the guard's held sequence: a real partial
    /// read ends its write on the lone `Esc` (no decodable body beside
    /// it), so the repair passes it through and the next write's
    /// continuation reassembles through the guard exactly as before —
    /// a split `ESC [ A` is the Up key, never `[A` typed.
    #[test]
    fn a_split_sequence_survives_the_repair_for_the_guard() {
        let _state = crate::enhanced_keys::TEST_STATE_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        crate::enhanced_keys::set_kitty_active_for_tests(false);
        let mut guard = SequenceGuard::default();
        let now = Instant::now();
        let feed_write = |guard: &mut SequenceGuard, events: Vec<Event>| -> Vec<GuardOutput> {
            merge_legacy_meta_escapes(events)
                .into_iter()
                .flat_map(|event| guard.feed(event, now))
                .collect()
        };
        // Write one ends right after the ESC byte: crossterm commits the
        // lone `Esc`, the repair leaves it, the guard holds it.
        let held = feed_write(
            &mut guard,
            vec![Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE))],
        );
        assert!(held.is_empty());
        // The next write carries the rest of the sequence as folded chars.
        let outputs = feed_write(&mut guard, vec![press('['), shift_press('A')]);
        assert_eq!(outputs.len(), 1, "{outputs:?}");
        let GuardOutput::Event(Event::Key(key)) = &outputs[0] else {
            panic!("the split sequence must decode to a key event");
        };
        assert_eq!(key.code, KeyCode::Up);
        assert_eq!(key.modifiers, KeyModifiers::NONE);
        assert!(guard
            .flush_expired(now + crate::sequence_guard::HOLD)
            .is_empty());
    }
}
