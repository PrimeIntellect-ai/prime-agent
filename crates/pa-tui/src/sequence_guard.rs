//! Escape-sequence guard over the reader's event seam (TS `StdinBuffer`). crossterm's 0.28 reader
//! commits a lone trailing `ESC` when an OS read ends on it, so the sequence it opened arrives in
//! the next read and parses as plain `Char` presses. TS holds a trailing `ESC` until the next chunk
//! completes the sequence or proves it stood alone; this module ports that discipline.

use std::time::{Duration, Instant};

use crossterm::event::{
    Event, KeyCode, KeyEvent, KeyEventKind, KeyEventState, KeyModifiers, MouseButton, MouseEvent,
    MouseEventKind,
};

use crate::mouse::{self, MouseEvent as Report};

/// How long a lone `ESC` (or a half-assembled sequence) waits for its continuation before flushing.
pub(crate) const HOLD: Duration = Duration::from_millis(10);

/// What the guard emits in place of one reader event: a passthrough event,
/// or a mouse report decoded from a reassembled sequence ([`crate::input::ReaderInput::Mouse`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum GuardOutput {
    Event(Event),
    Mouse(Report),
}

/// One held `ESC` and the sequence reassembled behind it, if any.
struct PendingEscape {
    /// The committed `Esc` press; re-emitted when nothing continues it.
    head: KeyEvent,
    /// The reassembled bytes so far, the opening `ESC` included.
    assembled: Vec<u8>,
    /// The event that carried the first continuation byte: the
    /// `ESC`+single-byte forms re-emit it with `ALT` added.
    first: Option<Event>,
    deadline: Instant,
}

impl PendingEscape {
    /// The deadline flush: a bare held `ESC` is the key press it looked
    /// like; a half-assembled sequence is dropped whole.
    fn flush(self) -> Vec<GuardOutput> {
        if self.assembled.len() == 1 {
            vec![GuardOutput::Event(Event::Key(self.head))]
        } else {
            Vec::new()
        }
    }
}

/// The reader's escape guard: holds committed lone `ESC`s and reassembles the sequences they opened
/// (see the module docs).
#[derive(Default)]
pub(crate) struct SequenceGuard {
    pending: Option<PendingEscape>,
}

impl SequenceGuard {
    pub(crate) fn feed(&mut self, event: Event, now: Instant) -> Vec<GuardOutput> {
        match self.pending.take() {
            None => match &event {
                Event::Key(key) if is_bare_esc_press(key) => {
                    self.pending = Some(PendingEscape {
                        head: *key,
                        assembled: vec![0x1b],
                        first: None,
                        deadline: now + HOLD,
                    });
                    Vec::new()
                }
                _ => vec![GuardOutput::Event(event)],
            },
            Some(mut pending) => {
                // The hold expired before this event arrived: the held `ESC` already stood alone,
                // so the flush goes out first and the event is a fresh input — never a continuation
                // (a late keystroke would otherwise arrive as Alt+<key>).
                if now >= pending.deadline {
                    let mut out = pending.flush();
                    out.extend(self.feed(event, now));
                    return out;
                }
                let Some(bytes) = continuation_bytes(&event) else {
                    // Not a continuation: the held `ESC` stood alone (or the
                    // sequence broke) — flush it, pass the event on.
                    let mut out = pending.flush();
                    out.push(GuardOutput::Event(event));
                    return out;
                };
                if pending.first.is_none() {
                    pending.first = Some(event);
                }
                pending.assembled.extend_from_slice(&bytes);
                // Every chunk that extends the buffer resets the flush timeout.
                pending.deadline = now + HOLD;
                if is_complete_sequence(&pending.assembled) {
                    classify(&pending)
                } else {
                    self.pending = Some(pending);
                    Vec::new()
                }
            }
        }
    }

    /// The parking wait: the remaining flush deadline while a partial
    /// sequence is held, or `None` to park until real input.
    pub(crate) fn poll_deadline(&self, now: Instant) -> Option<Duration> {
        self.pending
            .as_ref()
            .map(|pending| pending.deadline.saturating_duration_since(now))
    }

    pub(crate) fn flush_expired(&mut self, now: Instant) -> Vec<GuardOutput> {
        match self.pending.take() {
            Some(pending) if now >= pending.deadline => pending.flush(),
            Some(pending) => {
                self.pending = Some(pending);
                Vec::new()
            }
            None => Vec::new(),
        }
    }
}

/// A bare `Esc` press: the event a committed lone-`ESC` byte produces
/// (kitty releases and repeats are never sequence heads).
fn is_bare_esc_press(key: &KeyEvent) -> bool {
    key.code == KeyCode::Esc && key.kind == KeyEventKind::Press && key.modifiers.is_empty()
}

/// The byte(s) the event stands for in the terminal stream — the continuation forms crossterm's
/// byte parser produces after a committed `ESC`; `None` flushes and passes through.
fn continuation_bytes(event: &Event) -> Option<Vec<u8>> {
    let Event::Key(key) = event else {
        return None;
    };
    if key.kind != KeyEventKind::Press {
        return None;
    }
    match (&key.code, key.modifiers) {
        // A bare byte's parse: uppercase bytes carry SHIFT
        // (`char_code_to_event`), everything printable is itself.
        (KeyCode::Char(c), m) if m.is_empty() || (m == KeyModifiers::SHIFT && c.is_uppercase()) => {
            Some(c.to_string().into_bytes())
        }
        (KeyCode::Char(c), m) if m == KeyModifiers::CONTROL => control_byte(*c).map(|b| vec![b]),
        (KeyCode::Enter, m) if m.is_empty() => Some(b"\r".to_vec()),
        (KeyCode::Tab, m) if m.is_empty() => Some(b"\t".to_vec()),
        (KeyCode::Backspace, m) if m.is_empty() => Some(b"\x7f".to_vec()),
        (KeyCode::Esc, m) if m.is_empty() => Some(b"\x1b".to_vec()),
        _ => None,
    }
}

/// crossterm's control-byte parse (`parse_event`), reversed: the `Char` a raw control byte is
/// reported as, with `CONTROL`. Only the forms its parser produces are inverted; without the
/// 0x1c-0x1f rows (`Char('4'..='7')`) an Alt+Ctrl+digit combo after a read boundary would split
/// wrong.
fn control_byte(c: char) -> Option<u8> {
    match c {
        'a'..='z' => Some(c as u8 - b'a' + 1),
        ' ' => Some(0),
        '4'..='7' => Some(c as u8 - b'4' + 0x1c),
        _ => None,
    }
}

/// Whether `data` is a complete escape sequence or needs more bytes; non-ESC payloads are complete.
fn is_complete_sequence(data: &[u8]) -> bool {
    if data.first() != Some(&0x1b) {
        return true;
    }
    if data.len() == 1 {
        return false;
    }
    match data[1] {
        b'[' => {
            if data.len() >= 3 && data[2] == b'M' {
                // X10 mouse report: `ESC [ M Cb Cx Cy` — six bytes.
                return data.len() >= 6;
            }
            is_complete_csi(data)
        }
        b']' => ends_with_terminator(&data[1..], true),
        b'P' | b'_' => ends_with_terminator(&data[1..], false),
        b'O' => data.len() >= 3,
        _ => true,
    }
}

/// A CSI completes when its final byte is in the 0x40-0x7E range — except `<` payloads, which only
/// complete as an exact SGR mouse report.
fn is_complete_csi(data: &[u8]) -> bool {
    if data.len() < 3 {
        return false;
    }
    let payload = &data[2..];
    let last = payload[payload.len() - 1];
    if !(0x40..=0x7e).contains(&last) {
        return false;
    }
    if payload[0] != b'<' {
        return true;
    }
    is_sgr_mouse_payload(payload)
}

/// TS's SGR mouse matcher: `<cb;cx;cy` + `M|m`, three digit fields.
fn is_sgr_mouse_payload(payload: &[u8]) -> bool {
    let last = payload[payload.len() - 1];
    if last != b'M' && last != b'm' {
        return false;
    }
    let Ok(text) = std::str::from_utf8(&payload[1..payload.len() - 1]) else {
        return false;
    };
    let fields: Vec<&str> = text.split(';').collect();
    fields.len() == 3
        && fields
            .iter()
            .all(|f| !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()))
}

/// String sequences end at `ESC \` (ST); OSC also accepts BEL.
fn ends_with_terminator(after_esc: &[u8], bel: bool) -> bool {
    after_esc.ends_with(b"\x1b\\") || (bel && after_esc.ends_with(b"\x07"))
}

/// Classify a complete reassembled sequence before anything reaches the editor as text: mouse
/// reports decode, recognized keys synthesize their crossterm event, everything else is consumed.
fn classify(pending: &PendingEscape) -> Vec<GuardOutput> {
    let bytes = pending.assembled.as_slice();
    if bytes.starts_with(b"\x1b[<") {
        return decode_report(bytes, true);
    }
    if bytes.starts_with(b"\x1b[M") && bytes.len() == 6 {
        return decode_report(bytes, false);
    }
    // rxvt mouse: crossterm's own single-read parse delivers it as a mouse event, so a reassembled
    // one must decode the same way — the key classifier below would drop it.
    if bytes.starts_with(b"\x1b[") && bytes.ends_with(b"M") {
        return decode_rxvt_report(bytes);
    }
    if let Some(event) = classify_key(bytes, pending.first.as_ref()) {
        return vec![GuardOutput::Event(event)];
    }
    Vec::new()
}

/// An rxvt mouse report: three semicolon fields behind `ESC [`, `M` at the end — `cb` one-based by
/// 32, coordinates one-based, no release form; malformed fields decode to nothing.
fn decode_rxvt_report(bytes: &[u8]) -> Vec<GuardOutput> {
    let Ok(text) = std::str::from_utf8(&bytes[2..bytes.len() - 1]) else {
        return Vec::new();
    };
    let mut fields = text.split(';');
    let cb = fields
        .next()
        .and_then(|field| field.parse::<u8>().ok())
        .and_then(|cb| cb.checked_sub(32));
    let column = fields
        .next()
        .and_then(|field| field.parse::<u16>().ok())
        .map(|x| x.saturating_sub(1));
    let row = fields
        .next()
        .and_then(|field| field.parse::<u16>().ok())
        .map(|y| y.saturating_sub(1));
    let (Some(cb), Some(column), Some(row)) = (cb, column, row) else {
        return Vec::new();
    };
    let Some(kind) = report_kind(cb, true) else {
        return Vec::new();
    };
    let event = MouseEvent {
        kind,
        column,
        row,
        modifiers: report_modifiers(cb),
    };
    match mouse::from_crossterm(event) {
        Some(report) => vec![GuardOutput::Mouse(report)],
        None => Vec::new(),
    }
}

/// The modifier bits of a report's button byte: shift, alt, control, above the button bits.
fn report_modifiers(cb: u8) -> KeyModifiers {
    let mut modifiers = KeyModifiers::empty();
    if cb & 0b0000_0100 != 0 {
        modifiers |= KeyModifiers::SHIFT;
    }
    if cb & 0b0000_1000 != 0 {
        modifiers |= KeyModifiers::ALT;
    }
    if cb & 0b0001_0000 != 0 {
        modifiers |= KeyModifiers::CONTROL;
    }
    modifiers
}

/// Decode a reassembled mouse report: the button byte maps through the same table crossterm's
/// parser uses, then `mouse::from_crossterm` keeps the single dispatch filter (wheel and
/// left-button classes; other buttons consumed at the source, like crossterm's own reports).
fn decode_report(bytes: &[u8], sgr: bool) -> Vec<GuardOutput> {
    let (cb, column, row, press) = if sgr {
        let Ok(text) = std::str::from_utf8(&bytes[3..bytes.len() - 1]) else {
            return Vec::new();
        };
        let fields: Vec<&str> = text.split(';').collect();
        let (Ok(cb), Ok(x), Ok(y)) = (
            fields[0].parse::<u8>(),
            fields[1].parse::<u16>(),
            fields[2].parse::<u16>(),
        ) else {
            return Vec::new();
        };
        // SGR coordinates are one-based; crossterm reports zero-based.
        (
            cb,
            x.saturating_sub(1),
            y.saturating_sub(1),
            bytes[bytes.len() - 1] == b'M',
        )
    } else {
        let cb = bytes[3].wrapping_sub(32);
        (
            cb,
            u16::from(bytes[4].saturating_sub(32)).saturating_sub(1),
            u16::from(bytes[5].saturating_sub(32)).saturating_sub(1),
            true,
        )
    };
    let Some(kind) = report_kind(cb, press) else {
        return Vec::new();
    };
    let event = MouseEvent {
        kind,
        column,
        row,
        modifiers: report_modifiers(cb),
    };
    match mouse::from_crossterm(event) {
        Some(report) => vec![GuardOutput::Mouse(report)],
        None => Vec::new(),
    }
}

/// The X10/SGR button byte to event kind; an SGR release (`m`) turns a press report into a release.
fn report_kind(cb: u8, press: bool) -> Option<MouseEventKind> {
    let button = (cb & 0b0000_0011) | ((cb & 0b1100_0000) >> 4);
    let dragging = cb & 0b0010_0000 != 0;
    let kind = match (button, dragging) {
        (0, false) => MouseEventKind::Down(MouseButton::Left),
        (1, false) => MouseEventKind::Down(MouseButton::Middle),
        (2, false) => MouseEventKind::Down(MouseButton::Right),
        (0, true) => MouseEventKind::Drag(MouseButton::Left),
        (1, true) => MouseEventKind::Drag(MouseButton::Middle),
        (2, true) => MouseEventKind::Drag(MouseButton::Right),
        (3, false) => MouseEventKind::Up(MouseButton::Left),
        (3..=5, true) => MouseEventKind::Moved,
        (4, false) => MouseEventKind::ScrollUp,
        (5, false) => MouseEventKind::ScrollDown,
        (6, false) => MouseEventKind::ScrollLeft,
        (7, false) => MouseEventKind::ScrollRight,
        _ => return None,
    };
    Some(match (kind, press) {
        (MouseEventKind::Down(button), false) => MouseEventKind::Up(button),
        (kind, _) => kind,
    })
}

/// Recognized key sequences: their crossterm event; `None` consumes the sequence — unknown
/// sequences are dropped, never typed.
fn classify_key(bytes: &[u8], first: Option<&Event>) -> Option<Event> {
    match bytes {
        b"\x1b\x1b" => Some(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE))),
        // `ESC` + one character: crossterm re-parses the character's bytes and adds `ALT` — a
        // single byte for the ASCII and control forms, the whole UTF-8 character otherwise (never
        // split across events). The sequence openers below are excluded so they fall to their own
        // arms.
        [0x1b, byte, ..] if !matches!(byte, b'[' | b']' | b'P' | b'_' | b'O' | 0x1b) => match first
        {
            Some(Event::Key(key)) => {
                let mut key = *key;
                key.modifiers |= KeyModifiers::ALT;
                Some(Event::Key(key))
            }
            _ => None,
        },
        [0x1b, b'O', fin] => ss3_key(*fin),
        _ if bytes.starts_with(b"\x1b[") => csi_key(&bytes[2..]),
        _ => None,
    }
}

/// SS3 (`ESC O <fin>`): arrows, Home/End, F1-F4.
fn ss3_key(fin: u8) -> Option<Event> {
    let code = match fin {
        b'A' => KeyCode::Up,
        b'B' => KeyCode::Down,
        b'C' => KeyCode::Right,
        b'D' => KeyCode::Left,
        b'H' => KeyCode::Home,
        b'F' => KeyCode::End,
        b'P' => KeyCode::F(1),
        b'Q' => KeyCode::F(2),
        b'R' => KeyCode::F(3),
        b'S' => KeyCode::F(4),
        _ => return None,
    };
    Some(Event::Key(KeyEvent::new(code, KeyModifiers::NONE)))
}

/// CSI key forms crossterm's parser produces, plus the sequences it consumes
/// internally (focus, cursor position, kitty replies, paste markers) — all
/// consumed here so a reassembled one never reaches the editor as text.
fn csi_key(payload: &[u8]) -> Option<Event> {
    let final_byte = *payload.last()?;
    let body = &payload[..payload.len() - 1];
    match final_byte {
        b'A'..=b'D' | b'H' | b'F' => {
            let code = match final_byte {
                b'A' => KeyCode::Up,
                b'B' => KeyCode::Down,
                b'C' => KeyCode::Right,
                b'D' => KeyCode::Left,
                b'H' => KeyCode::Home,
                _ => KeyCode::End,
            };
            let (modifiers, kind) = modifier_params(body);
            Some(Event::Key(KeyEvent::new_with_kind(code, modifiers, kind)))
        }
        b'P' | b'Q' | b'S' => {
            let code = match final_byte {
                b'P' => KeyCode::F(1),
                b'Q' => KeyCode::F(2),
                _ => KeyCode::F(4),
            };
            let (modifiers, kind) = modifier_params(body);
            Some(Event::Key(KeyEvent::new_with_kind(code, modifiers, kind)))
        }
        b'Z' => Some(Event::Key(KeyEvent::new_with_kind(
            KeyCode::BackTab,
            KeyModifiers::SHIFT,
            KeyEventKind::Press,
        ))),
        b'~' => tilde_key(body),
        b'u' if body.first() == Some(&b'?') => None, // kitty flags reply
        b'u' => csi_u_key(body),
        b'I' => Some(Event::FocusGained),
        b'O' => Some(Event::FocusLost),
        // Cursor position and device attributes: crossterm parks these as internal events its
        // `read()` never yields.
        _ => None,
    }
}

/// The `1;mods(:kind)` parameter tail: an empty or `"1"`-only tail carries no modifiers, a
/// digit-only tail is the mask itself (the legacy omitted-1 form), `mods:kind` the kitty event
/// kind.
fn modifier_params(body: &[u8]) -> (KeyModifiers, KeyEventKind) {
    let Ok(text) = std::str::from_utf8(body) else {
        return (KeyModifiers::NONE, KeyEventKind::Press);
    };
    let mut fields = text.split(';');
    let first = fields.next().unwrap_or_default();
    let Some(mods_field) = fields.next() else {
        // `ESC [ 5 A`: the digit directly before the final byte is the mask (the omitted-1 form).
        let mask = first
            .bytes()
            .next_back()
            .filter(u8::is_ascii_digit)
            .map_or(1, |b| b - b'0');
        return (parse_modifiers(mask), KeyEventKind::Press);
    };
    let mut parts = mods_field.split(':');
    let Ok(mask) = parts.next().unwrap_or_default().parse::<u8>() else {
        return (KeyModifiers::NONE, KeyEventKind::Press);
    };
    let kind = parts
        .next()
        .and_then(|k| k.parse::<u8>().ok())
        .map_or(KeyEventKind::Press, parse_kind);
    (parse_modifiers(mask), kind)
}

/// crossterm's `parse_modifiers`: the mask is one-based (bit 1 = shift).
fn parse_modifiers(mask: u8) -> KeyModifiers {
    let mask = mask.saturating_sub(1);
    let mut modifiers = KeyModifiers::empty();
    if mask & 1 != 0 {
        modifiers |= KeyModifiers::SHIFT;
    }
    if mask & 2 != 0 {
        modifiers |= KeyModifiers::ALT;
    }
    if mask & 4 != 0 {
        modifiers |= KeyModifiers::CONTROL;
    }
    if mask & 8 != 0 {
        modifiers |= KeyModifiers::SUPER;
    }
    if mask & 16 != 0 {
        modifiers |= KeyModifiers::HYPER;
    }
    if mask & 32 != 0 {
        modifiers |= KeyModifiers::META;
    }
    modifiers
}

fn parse_kind(kind: u8) -> KeyEventKind {
    match kind {
        2 => KeyEventKind::Repeat,
        3 => KeyEventKind::Release,
        _ => KeyEventKind::Press,
    }
}

/// The tilde forms: navigation and function keys; every other number (paste
/// markers included) is consumed.
fn tilde_key(body: &[u8]) -> Option<Event> {
    let text = std::str::from_utf8(body).ok()?;
    let mut fields = text.split(';');
    let first: u8 = fields.next()?.parse().ok()?;
    let (modifiers, kind) = match fields.next() {
        Some(mods_field) => {
            let mut parts = mods_field.split(':');
            let mask = parts.next().unwrap_or_default().parse::<u8>().unwrap_or(1);
            let kind = parts
                .next()
                .and_then(|k| k.parse::<u8>().ok())
                .map_or(KeyEventKind::Press, parse_kind);
            (parse_modifiers(mask), kind)
        }
        None => (KeyModifiers::NONE, KeyEventKind::Press),
    };
    let code = match first {
        1 | 7 => KeyCode::Home,
        2 => KeyCode::Insert,
        3 => KeyCode::Delete,
        4 | 8 => KeyCode::End,
        5 => KeyCode::PageUp,
        6 => KeyCode::PageDown,
        v @ 11..=15 => KeyCode::F(v - 10),
        v @ 17..=21 => KeyCode::F(v - 11),
        v @ 23..=26 => KeyCode::F(v - 12),
        v @ 28..=29 => KeyCode::F(v - 15),
        v @ 31..=34 => KeyCode::F(v - 17),
        _ => return None,
    };
    Some(Event::Key(KeyEvent::new_with_kind(code, modifiers, kind)))
}

/// CSI-u / kitty: printable codepoints and the control specials, with the shifted alternate
/// resolving to the produced character. The 57xxx functional range is consumed — a split keypad
/// report must not leak, and no surface this reader feeds dispatches those keys.
fn csi_u_key(body: &[u8]) -> Option<Event> {
    let text = std::str::from_utf8(body).ok()?;
    let mut fields = text.split(';');
    let mut codepoints = fields.next()?.split(':');
    let codepoint: u32 = codepoints.next()?.parse().ok()?;
    let (mut modifiers, kind, lock_state) = match fields.next() {
        Some(mods_field) => {
            let mut parts = mods_field.split(':');
            let mask = parts.next().unwrap_or_default().parse::<u8>().unwrap_or(1);
            let kind = parts
                .next()
                .and_then(|k| k.parse::<u8>().ok())
                .map_or(KeyEventKind::Press, parse_kind);
            (parse_modifiers(mask), kind, lock_state(mask))
        }
        None => (
            KeyModifiers::NONE,
            KeyEventKind::Press,
            KeyEventState::empty(),
        ),
    };
    let (mut code, state_from_keycode) = match codepoint {
        // The kitty keypad block: its characters, Enter, and navigation decode exactly like the
        // unsplit parse instead of vanishing on a split read (TS maps the same block).
        57399..=57408 => (
            KeyCode::Char(char::from_u32(codepoint - 57399 + u32::from(b'0'))?),
            KeyEventState::KEYPAD,
        ),
        57409..=57413 => (
            match codepoint {
                57409 => KeyCode::Char('.'),
                57410 => KeyCode::Char('/'),
                57411 => KeyCode::Char('*'),
                57412 => KeyCode::Char('-'),
                _ => KeyCode::Char('+'),
            },
            KeyEventState::KEYPAD,
        ),
        57414 => (KeyCode::Enter, KeyEventState::KEYPAD),
        57415..=57416 => (
            match codepoint {
                57415 => KeyCode::Char('='),
                _ => KeyCode::Char(','),
            },
            KeyEventState::KEYPAD,
        ),
        57417..=57426 => (
            match codepoint {
                57417 => KeyCode::Left,
                57418 => KeyCode::Right,
                57419 => KeyCode::Up,
                57420 => KeyCode::Down,
                57421 => KeyCode::PageUp,
                57422 => KeyCode::PageDown,
                57423 => KeyCode::Home,
                57424 => KeyCode::End,
                57425 => KeyCode::Insert,
                _ => KeyCode::Delete,
            },
            KeyEventState::KEYPAD,
        ),
        0x1b => (KeyCode::Esc, KeyEventState::empty()),
        0x0d => (KeyCode::Enter, KeyEventState::empty()),
        // Raw mode is always on under this reader, so LF is not Enter.
        0x0a => (KeyCode::Char('\n'), KeyEventState::empty()),
        0x09 if modifiers.contains(KeyModifiers::SHIFT) => {
            (KeyCode::BackTab, KeyEventState::empty())
        }
        0x09 => (KeyCode::Tab, KeyEventState::empty()),
        0x7f => (KeyCode::Backspace, KeyEventState::empty()),
        // The rest of the kitty functional range: no surface this reader feeds dispatches those
        // keys (TS drops them too), and a split report must not turn into a text character.
        c if (57344..=63743).contains(&c) => return None,
        c => (KeyCode::Char(char::from_u32(c)?), KeyEventState::empty()),
    };
    if modifiers.contains(KeyModifiers::SHIFT) {
        if let Some(shifted) = codepoints
            .next()
            .and_then(|c| c.parse::<u32>().ok())
            .and_then(char::from_u32)
        {
            code = KeyCode::Char(shifted);
            modifiers.set(KeyModifiers::SHIFT, false);
        }
    }
    Some(Event::Key(KeyEvent::new_with_kind_and_state(
        code,
        modifiers,
        kind,
        state_from_keycode | lock_state,
    )))
}

/// The lock bits ride the mask above the modifier bits — caps lock and num lock, delivered as event
/// state.
fn lock_state(mask: u8) -> KeyEventState {
    let mask = mask.saturating_sub(1);
    let mut state = KeyEventState::empty();
    if mask & 64 != 0 {
        state |= KeyEventState::CAPS_LOCK;
    }
    if mask & 128 != 0 {
        state |= KeyEventState::NUM_LOCK;
    }
    state
}
#[cfg(test)]
mod tests;
