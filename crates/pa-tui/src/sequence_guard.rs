//! Escape-sequence guard over the reader's event seam (TS `StdinBuffer`).
//!
//! crossterm owns the tty bytes and their parser, and its 0.28 reader
//! commits a lone trailing `ESC` the moment an OS read ends on it:
//! `Parser::advance` passes `more = read_count == TTY_BUFFER_SIZE`, so
//! every partial-read tail parses `ESC` with no bytes after it, and
//! `parse_event(b"\x1b", more=false)` yields an `Esc` press. The sequence
//! that `ESC` opened then arrives in the next read and parses
//! byte-by-byte as plain `Char` presses — during a mouse drag that is the
//! body of an SGR report (`[<64;20;5M`), the "random escape sequences"
//! users have seen land inside the editor.
//!
//! TS never commits that early: `StdinBuffer` holds a trailing `ESC`
//! until the next chunk either completes the sequence (within a 10 ms
//! window) or proves it stood alone, and only complete sequences reach
//! the key parser — unknown ones are dropped, never typed. This module
//! ports that discipline onto the events crossterm emits:
//!
//! - a bare `Esc` press is held for [`HOLD`] (TS `StdinBuffer.timeout`);
//! - continuation bytes reassemble the sequence; a complete one is
//!   classified before any text insertion: SGR/X10/rxvt mouse reports
//!   decode through `mouse`, recognized key sequences synthesize the
//!   event crossterm's own single-read parse would have produced, and
//!   everything else is consumed (dropped);
//! - a sequence still incomplete at the deadline is dropped whole — the
//!   editor never sees escape bytes as text;
//! - a held `Esc` that nothing continues flushes as the key press.

use std::time::{Duration, Instant};

use crossterm::event::{
    Event, KeyCode, KeyEvent, KeyEventKind, KeyEventState, KeyModifiers, MouseButton, MouseEvent,
    MouseEventKind,
};

use crate::mouse::{self, MouseEvent as Report};

/// TS `StdinBuffer.timeout`: how long a lone `ESC` (or a half-assembled
/// sequence) waits for its continuation before flushing.
pub(crate) const HOLD: Duration = Duration::from_millis(10);

/// What the guard emits in place of one reader event: a passthrough
/// event, or a mouse report decoded from a reassembled sequence (the
/// reader forwards it as [`crate::input::ReaderInput::Mouse`]).
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
    /// `ESC`+single-byte forms re-emit it with `ALT` added, crossterm's
    /// own single-read parse of `\x1b<c>`.
    first: Option<Event>,
    deadline: Instant,
}

impl PendingEscape {
    /// The deadline flush: a bare held `ESC` is the key press it looked
    /// like; a half-assembled sequence is dropped whole (TS flushes the
    /// raw remainder to the parser, which drops the escape form too).
    fn flush(self) -> Vec<GuardOutput> {
        if self.assembled.len() == 1 {
            vec![GuardOutput::Event(Event::Key(self.head))]
        } else {
            Vec::new()
        }
    }
}

/// The reader's escape guard: holds committed lone `ESC`s and reassembles
/// the sequences they opened (module docs: the TS `StdinBuffer` port).
#[derive(Default)]
pub(crate) struct SequenceGuard {
    pending: Option<PendingEscape>,
}

impl SequenceGuard {
    /// Feed one reader event; returns what to deliver in its place.
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
                // The hold expired before this event arrived: the held
                // `ESC` already stood alone (TS's timer flushed it), so the
                // flush goes out first and the event is a fresh input —
                // never a continuation (a late keystroke would otherwise
                // arrive as Alt+<key>).
                if now >= pending.deadline {
                    let mut out = pending.flush();
                    out.extend(self.feed(event, now));
                    return out;
                }
                let Some(bytes) = continuation_bytes(&event) else {
                    // Not a continuation: the held `ESC` stood alone (or
                    // the sequence broke) — flush it, pass the event on.
                    let mut out = pending.flush();
                    out.push(GuardOutput::Event(event));
                    return out;
                };
                if pending.first.is_none() {
                    pending.first = Some(event);
                }
                pending.assembled.extend_from_slice(&bytes);
                // TS: every chunk that extends the buffer resets the
                // flush timeout.
                pending.deadline = now + HOLD;
                if is_complete_sequence(&pending.assembled) {
                    classify(pending)
                } else {
                    self.pending = Some(pending);
                    Vec::new()
                }
            }
        }
    }

    /// The poll wait: never past a pending sequence's deadline.
    pub(crate) fn poll_timeout(&self, default: Duration, now: Instant) -> Duration {
        match &self.pending {
            Some(pending) => default.min(pending.deadline.saturating_duration_since(now)),
            None => default,
        }
    }

    /// Flush whatever the deadline released.
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

/// The byte(s) the event stands for in the terminal stream — the
/// continuation forms crossterm's byte parser produces after a committed
/// `ESC`. `None` flushes the held `ESC` and passes the event through.
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

/// crossterm's control-byte parse (`parse_event`), reversed: the `Char` a
/// raw control byte is reported as, with `CONTROL`. Only the forms its
/// parser produces are inverted — `ESC` itself opens a sequence instead,
/// and the caret-notation forms (`^[`, `^\\`, ...) never survive it:
/// 0x1c-0x1f arrive as `Char('4'..='7')`, so without those rows an
/// Alt+Ctrl+digit combo after a read boundary would split wrong.
fn control_byte(c: char) -> Option<u8> {
    match c {
        'a'..='z' => Some(c as u8 - b'a' + 1),
        ' ' => Some(0),
        '4'..='7' => Some(c as u8 - b'4' + 0x1c),
        _ => None,
    }
}

/// TS `isCompleteSequence`: whether `data` is a complete escape sequence
/// or needs more bytes. Non-ESC payloads (plain bytes) are complete.
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

/// TS `isCompleteCsiSequence`: a CSI completes when its final byte is in
/// the 0x40-0x7E range — except `<` payloads, which only ever complete as
/// an exact SGR mouse report, so a report split mid-numbers stays held
/// instead of completing on the first stray final byte.
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

/// TS `isCompleteOscSequence` / DCS / APC: string sequences end at
/// `ESC \` (ST); OSC also accepts BEL.
fn ends_with_terminator(after_esc: &[u8], bel: bool) -> bool {
    after_esc.ends_with(b"\x1b\\") || (bel && after_esc.ends_with(b"\x07"))
}

/// Classify a complete reassembled sequence before anything can reach the
/// editor as text: mouse reports decode, recognized keys synthesize their
/// crossterm event, and everything else — OSC/DCS/APC replies, focus and
/// cursor reports, kitty replies, paste markers, unknown forms — is
/// consumed.
fn classify(pending: PendingEscape) -> Vec<GuardOutput> {
    let bytes = pending.assembled.as_slice();
    // Mouse reports first: the drag stream is a dense run of them.
    if bytes.starts_with(b"\x1b[<") {
        return decode_report(bytes, true);
    }
    if bytes.starts_with(b"\x1b[M") && bytes.len() == 6 {
        return decode_report(bytes, false);
    }
    // rxvt mouse (`ESC [ cb ; cx ; cy (;) M`, mode 1015): crossterm's own
    // single-read parse delivers it as a mouse event, so a reassembled
    // one must decode the same way — the key classifier below would
    // drop it, and clicks and drags would vanish only when a read
    // boundary splits the report.
    if bytes.starts_with(b"\x1b[") && bytes.ends_with(b"M") {
        return decode_rxvt_report(bytes);
    }
    if let Some(event) = classify_key(bytes, pending.first.as_ref()) {
        return vec![GuardOutput::Event(event)];
    }
    Vec::new()
}

/// An rxvt mouse report (crossterm `parse_csi_rxvt_mouse`): three
/// semicolon fields behind `ESC [`, `M` at the end — `cb` one-based by
/// 32 and the coordinates one-based, with no release form (the final
/// byte is always `M`; the release distinction is SGR-only). Malformed
/// fields (the same shapes crossterm rejects) decode to nothing.
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
    match mouse::from_crossterm(&event) {
        Some(report) => vec![GuardOutput::Mouse(report)],
        None => Vec::new(),
    }
}

/// The modifier bits of a report's button byte (crossterm `parse_cb`):
/// shift, alt (meta), control, above the button bits.
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

/// Decode a reassembled mouse report into the reader's report type: the
/// button byte maps through the same table crossterm's parser uses, then
/// `mouse::from_crossterm` keeps the single dispatch filter (wheel and
/// left-button classes; hover motion and other buttons are consumed at
/// the source, exactly like the reports crossterm parses itself).
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
    match mouse::from_crossterm(&event) {
        Some(report) => vec![GuardOutput::Mouse(report)],
        None => Vec::new(),
    }
}

/// crossterm's `parse_cb`: the X10/SGR button byte to event kind. An SGR
/// release (`m`) turns a press report into a release.
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

/// Recognized key sequences: their crossterm event. `None` consumes the
/// sequence — unknown sequences are dropped, never typed.
fn classify_key(bytes: &[u8], first: Option<&Event>) -> Option<Event> {
    match bytes {
        // crossterm's parse of a lone `ESC ESC`: one `Esc`.
        b"\x1b\x1b" => Some(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE))),
        // `ESC` + one character: crossterm re-parses the character's
        // bytes and adds `ALT` — a single byte for the ASCII and control
        // forms, the whole UTF-8 character otherwise (its parser never
        // splits a character across events, so a longer tail is always
        // one character). `first` is the event that carried it. The
        // sequence openers (`[`, `]`, `P`, `_`, `O`, a second `ESC`) are
        // excluded here so they fall to their own arms below.
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

/// CSI (`ESC [ <payload>`): the key forms crossterm's parser produces,
/// plus the sequences it consumes internally — focus transitions, cursor
/// position, kitty replies, paste markers — all consumed here so a
/// reassembled one can never reach the editor as text.
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
        // Cursor position and device attributes: crossterm parks these as
        // internal events its `read()` never yields.
        b'R' | b'c' => None,
        _ => None,
    }
}

/// The `1;mods(:kind)` parameter tail (crossterm's
/// `parse_csi_modifier_key_code`): an empty or `"1"`-only tail carries no
/// modifiers, a digit-only tail is the mask itself (the legacy omitted-1
/// form), and `mods:kind` carries the kitty event kind.
fn modifier_params(body: &[u8]) -> (KeyModifiers, KeyEventKind) {
    let Ok(text) = std::str::from_utf8(body) else {
        return (KeyModifiers::NONE, KeyEventKind::Press);
    };
    let mut fields = text.split(';');
    let first = fields.next().unwrap_or_default();
    let Some(mods_field) = fields.next() else {
        // `ESC [ 5 A`: the digit directly before the final byte is the
        // mask (crossterm's fallback for the omitted-1 form).
        let mask = first
            .bytes()
            .next_back()
            .filter(u8::is_ascii_digit)
            .map(|b| b - b'0')
            .unwrap_or(1);
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

/// The tilde forms (`ESC [ <n> (;mods(:kind)?)? ~`): navigation and
/// function keys; every other number (paste markers included) is
/// consumed.
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

/// CSI-u / kitty (`ESC [ <cp>(:alt)?(;mods(:kind)?)? u`): printable
/// codepoints and the control specials, with the shifted alternate
/// resolving to the produced character. The 57xxx functional range is
/// consumed — a split keypad report must not leak, and no surface this
/// reader feeds dispatches those keys.
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
        // The keypad block of the kitty functional range (crossterm
        // `translate_functional_key_code`): its characters, Enter, and
        // navigation decode exactly like the unsplit parse — with the
        // KEYPAD state it stamps on them — instead of vanishing on a
        // split read. TS maps the same block
        // (keys.ts KITTY_FUNCTIONAL_KEY_EQUIVALENTS).
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
        // Raw mode is always on under this reader, so LF is not Enter
        // (crossterm's own raw-mode branch).
        0x0a => (KeyCode::Char('\n'), KeyEventState::empty()),
        0x09 if modifiers.contains(KeyModifiers::SHIFT) => {
            (KeyCode::BackTab, KeyEventState::empty())
        }
        0x09 => (KeyCode::Tab, KeyEventState::empty()),
        0x7f => (KeyCode::Backspace, KeyEventState::empty()),
        // The rest of the kitty functional range: no surface this reader
        // feeds dispatches those keys (F13+, media and modifier
        // reports — TS drops them too), and a split report must not
        // turn into a text character.
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

/// crossterm's `parse_modifiers_to_state`: the lock bits ride the mask
/// above the modifier bits — caps lock and num lock, delivered as event
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
mod tests {
    use super::*;
    use crossterm::event::{MouseEvent as CtMouse, MouseEventKind as CtMouseKind};

    fn esc_press() -> Event {
        Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE))
    }

    fn char_press(c: char) -> Event {
        Event::Key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE))
    }

    /// The guard's view of a reader run: one feed per event on a 1 ms
    /// clock, then one deadline flush.
    fn run_guard(events: Vec<Event>) -> Vec<GuardOutput> {
        let mut guard = SequenceGuard::default();
        let mut now = Instant::now();
        let mut out = Vec::new();
        for event in events {
            out.extend(guard.feed(event, now));
            now += Duration::from_millis(1);
        }
        now += HOLD;
        out.extend(guard.flush_expired(now));
        out
    }

    fn sgr(button: u8, x: u16, y: u16, press: bool) -> String {
        format!("\x1b[<{button};{x};{y}{}", if press { 'M' } else { 'm' })
    }

    /// The SGR reports a real terminal emits with `?1002` + `?1006`
    /// tracking (the #264 battery's classes, plus the reports the
    /// dispatch filter consumes).
    fn report_corpus() -> Vec<String> {
        vec![
            sgr(0, 13, 2, true),   // left press
            sgr(32, 14, 2, true),  // left drag
            sgr(0, 14, 2, false),  // left release
            sgr(64, 20, 5, true),  // wheel up
            sgr(65, 20, 5, true),  // wheel down
            sgr(0, 100, 30, true), // three-digit coordinates
            sgr(35, 7, 9, true),   // hover motion (consumed)
            sgr(1, 3, 4, true),    // middle press (consumed)
        ]
    }

    /// What leaked as key presses: events the editor would insert or act
    /// on. Mouse reports of both shapes are the expected payload instead.
    fn leaks(outputs: &[GuardOutput]) -> Vec<Event> {
        outputs
            .iter()
            .filter_map(|out| match out {
                // Only key presses reach the editor as text or actions;
                // mouse reports of both shapes are the expected payload.
                GuardOutput::Event(event @ Event::Key(_)) => Some(event.clone()),
                _ => None,
            })
            .collect()
    }

    fn reports(outputs: &[GuardOutput]) -> Vec<Report> {
        outputs
            .iter()
            .filter_map(|out| match out {
                GuardOutput::Mouse(report) => Some(*report),
                GuardOutput::Event(Event::Mouse(mouse)) => mouse::from_crossterm(mouse),
                _ => None,
            })
            .collect()
    }

    // -- the read-boundary defect and its repair ------------------------

    /// The events crossterm 0.28.1's reader produces for a byte stream
    /// split into OS reads after each `split_after` offset. Its
    /// `Parser::advance` (event/source/unix/mio.rs) parses byte-by-byte,
    /// holds an incomplete sequence across reads, clears on a parse
    /// error, and passes `more = read_count == TTY_BUFFER_SIZE` — so a
    /// partial read ending on `ESC` parses `parse_event(b"\x1b",
    /// more=false)` and commits an `Esc` press (event/sys/unix/parse.rs).
    /// The model covers the forms this lane feeds it.
    fn read_projection(stream: &[u8], split_after: &[usize]) -> Vec<Event> {
        let mut ends: Vec<usize> = split_after
            .iter()
            .copied()
            .filter(|&e| e > 0 && e < stream.len())
            .collect();
        ends.sort_unstable();
        ends.dedup();
        ends.push(stream.len());

        let mut events = Vec::new();
        let mut buf: Vec<u8> = Vec::new();
        let mut start = 0;
        for &end in &ends {
            let chunk = &stream[start..end];
            start = end;
            for (idx, &b) in chunk.iter().enumerate() {
                let more = idx + 1 < chunk.len();
                buf.push(b);
                match model_parse(&buf, more) {
                    ModelParse::Event(event) => {
                        events.push(event);
                        buf.clear();
                    }
                    ModelParse::Invalid => buf.clear(),
                    ModelParse::More => {}
                }
            }
        }
        events
    }

    enum ModelParse {
        Event(Event),
        More,
        Invalid,
    }

    /// crossterm 0.28.1's byte parser, the forms the projection corpus
    /// reaches (plain bytes, SGR/X10 mouse, CSI keys, kitty CSI-u).
    fn model_parse(buf: &[u8], more: bool) -> ModelParse {
        if buf[0] != 0x1b {
            if buf[0] >= 0x80 {
                // `parse_utf8_char`: an incomplete code point keeps
                // buffering (never an event), a complete one is the
                // character (SHIFT only on uppercase, like
                // `char_code_to_event`).
                return match std::str::from_utf8(buf) {
                    Ok(text) => {
                        let ch = text.chars().next().expect("non-empty");
                        let modifiers = if ch.is_uppercase() {
                            KeyModifiers::SHIFT
                        } else {
                            KeyModifiers::NONE
                        };
                        ModelParse::Event(Event::Key(KeyEvent::new(KeyCode::Char(ch), modifiers)))
                    }
                    Err(error) if error.error_len().is_none() => ModelParse::More,
                    Err(_) => ModelParse::Invalid,
                };
            }
            // The control rows of `parse_event`, then
            // `char_code_to_event` (uppercase bytes carry SHIFT).
            return match buf[0] {
                b'\r' => ModelParse::Event(Event::Key(KeyCode::Enter.into())),
                b'\t' => ModelParse::Event(Event::Key(KeyCode::Tab.into())),
                0x7f => ModelParse::Event(Event::Key(KeyCode::Backspace.into())),
                c @ 0x01..=0x1a => ModelParse::Event(Event::Key(KeyEvent::new(
                    KeyCode::Char((c - 0x1 + b'a') as char),
                    KeyModifiers::CONTROL,
                ))),
                c @ 0x1c..=0x1f => ModelParse::Event(Event::Key(KeyEvent::new(
                    KeyCode::Char((c - 0x1c + b'4') as char),
                    KeyModifiers::CONTROL,
                ))),
                0x00 => ModelParse::Event(Event::Key(KeyEvent::new(
                    KeyCode::Char(' '),
                    KeyModifiers::CONTROL,
                ))),
                c => {
                    let ch = char::from_u32(u32::from(c)).expect("ascii corpus");
                    let modifiers = if ch.is_uppercase() {
                        KeyModifiers::SHIFT
                    } else {
                        KeyModifiers::NONE
                    };
                    ModelParse::Event(Event::Key(KeyEvent::new(KeyCode::Char(ch), modifiers)))
                }
            };
        }
        if buf.len() == 1 {
            // The defect: a lone `ESC` at a partial-read tail commits.
            return if more {
                ModelParse::More
            } else {
                ModelParse::Event(Event::Key(KeyCode::Esc.into()))
            };
        }
        match buf[1] {
            0x1b => ModelParse::Event(Event::Key(KeyCode::Esc.into())),
            b'[' => {
                if buf.len() == 2 {
                    return ModelParse::More;
                }
                let payload = &buf[2..];
                let last = *payload.last().expect("non-empty");
                if !(0x40..=0x7e).contains(&last) {
                    return ModelParse::More;
                }
                if payload[0] == b'<' {
                    if last != b'M' && last != b'm' {
                        return ModelParse::More;
                    }
                    let Ok(text) = std::str::from_utf8(&payload[1..payload.len() - 1]) else {
                        return ModelParse::Invalid;
                    };
                    let fields: Vec<&str> = text.split(';').collect();
                    let (Ok(cb), Ok(x), Ok(y)) = (
                        fields[0].parse::<u8>(),
                        fields[1].parse::<u16>(),
                        fields[2].parse::<u16>(),
                    ) else {
                        return ModelParse::Invalid;
                    };
                    let kind = report_kind(cb, last == b'M').expect("corpus buttons");
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
                    return ModelParse::Event(Event::Mouse(CtMouse {
                        kind,
                        column: x - 1,
                        row: y - 1,
                        modifiers,
                    }));
                }
                if payload[0] == b'M' {
                    // X10: `ESC [ M Cb Cx Cy`.
                    if buf.len() < 6 {
                        return ModelParse::More;
                    }
                    let kind = report_kind(buf[3].wrapping_sub(32), true).expect("corpus buttons");
                    return ModelParse::Event(Event::Mouse(CtMouse {
                        kind,
                        column: u16::from(buf[4]) - 32 - 1,
                        row: u16::from(buf[5]) - 32 - 1,
                        modifiers: KeyModifiers::NONE,
                    }));
                }
                if payload[0] == b'[' {
                    // `ESC [ [ <fin>`: parse_csi holds the three-byte
                    // prefix for the fourth byte, then F1-F5 (any other
                    // final byte is a parse error it drops whole).
                    if buf.len() == 3 {
                        return ModelParse::More;
                    }
                    return match last {
                        val @ b'A'..=b'E' => {
                            ModelParse::Event(Event::Key(KeyCode::F(1 + val - b'A').into()))
                        }
                        _ => ModelParse::Invalid,
                    };
                }
                match last {
                    b'A' => ModelParse::Event(Event::Key(KeyCode::Up.into())),
                    b'B' => ModelParse::Event(Event::Key(KeyCode::Down.into())),
                    b'C' => ModelParse::Event(Event::Key(KeyCode::Right.into())),
                    b'D' => ModelParse::Event(Event::Key(KeyCode::Left.into())),
                    // rxvt mouse (`parse_csi_rxvt_mouse`): `cb ; cx ; cy`
                    // behind a digit-led CSI, `M` at the end.
                    b'M' if payload[0].is_ascii_digit() => {
                        let text = std::str::from_utf8(&payload[..payload.len() - 1])
                            .expect("corpus is ascii");
                        let mut fields = text.split(';');
                        let cb = fields
                            .next()
                            .and_then(|field| field.parse::<u8>().ok())
                            .and_then(|cb| cb.checked_sub(32))
                            .expect("corpus buttons");
                        let x: u16 = fields
                            .next()
                            .expect("corpus coordinates")
                            .parse()
                            .expect("corpus coordinates");
                        let y: u16 = fields
                            .next()
                            .expect("corpus coordinates")
                            .parse()
                            .expect("corpus coordinates");
                        let kind = report_kind(cb, true).expect("corpus buttons");
                        ModelParse::Event(Event::Mouse(CtMouse {
                            kind,
                            column: x - 1,
                            row: y - 1,
                            modifiers: report_modifiers(cb),
                        }))
                    }
                    b'u' => {
                        let text = std::str::from_utf8(&payload[..payload.len() - 1])
                            .expect("corpus is ascii");
                        let codepoint: u32 = text
                            .split(';')
                            .next()
                            .expect("non-empty")
                            .parse()
                            .expect("corpus");
                        if (57399..=57426).contains(&codepoint) {
                            // translate_functional_key_code: the keypad
                            // block decodes to its characters, Enter, and
                            // navigation, with the KEYPAD state.
                            let code = match codepoint {
                                c @ 57399..=57408 => KeyCode::Char(
                                    char::from_u32(c - 57399 + u32::from(b'0')).expect("digits"),
                                ),
                                57409 => KeyCode::Char('.'),
                                57410 => KeyCode::Char('/'),
                                57411 => KeyCode::Char('*'),
                                57412 => KeyCode::Char('-'),
                                57413 => KeyCode::Char('+'),
                                57414 => KeyCode::Enter,
                                57415 => KeyCode::Char('='),
                                57416 => KeyCode::Char(','),
                                57417 => KeyCode::Left,
                                57418 => KeyCode::Right,
                                57419 => KeyCode::Up,
                                57420 => KeyCode::Down,
                                57421 => KeyCode::PageUp,
                                57422 => KeyCode::PageDown,
                                57423 => KeyCode::Home,
                                57424 => KeyCode::End,
                                57425 => KeyCode::Insert,
                                57426 => KeyCode::Delete,
                                _ => unreachable!("the keypad range is checked above"),
                            };
                            return ModelParse::Event(Event::Key(
                                KeyEvent::new_with_kind_and_state(
                                    code,
                                    KeyModifiers::NONE,
                                    KeyEventKind::Press,
                                    KeyEventState::KEYPAD,
                                ),
                            ));
                        }
                        match codepoint {
                            27 => ModelParse::Event(Event::Key(KeyCode::Esc.into())),
                            c => ModelParse::Event(Event::Key(KeyEvent::new(
                                KeyCode::Char(char::from_u32(c).expect("corpus")),
                                KeyModifiers::NONE,
                            ))),
                        }
                    }
                    b'~' if payload == b"200~" || payload == b"201~" => ModelParse::Invalid,
                    _ => ModelParse::Invalid,
                }
            }
            // crossterm's ESC branch re-parses the remaining bytes and
            // adds ALT: control bytes keep their control forms, ASCII and
            // UTF-8 characters are their key.
            _ => {
                let inner = &buf[1..];
                if inner[0] >= 0x80 {
                    return match std::str::from_utf8(inner) {
                        Ok(text) => {
                            let ch = text.chars().next().expect("non-empty");
                            let mut modifiers = KeyModifiers::ALT;
                            if ch.is_uppercase() {
                                modifiers |= KeyModifiers::SHIFT;
                            }
                            ModelParse::Event(Event::Key(KeyEvent::new(
                                KeyCode::Char(ch),
                                modifiers,
                            )))
                        }
                        Err(error) if error.error_len().is_none() => ModelParse::More,
                        Err(_) => ModelParse::Invalid,
                    };
                }
                let (code, modifiers) = match inner[0] {
                    b'\r' => (KeyCode::Enter, KeyModifiers::ALT),
                    b'\t' => (KeyCode::Tab, KeyModifiers::ALT),
                    0x7f => (KeyCode::Backspace, KeyModifiers::ALT),
                    c @ 0x01..=0x1a => (
                        KeyCode::Char((c - 0x1 + b'a') as char),
                        KeyModifiers::CONTROL | KeyModifiers::ALT,
                    ),
                    c @ 0x1c..=0x1f => (
                        KeyCode::Char((c - 0x1c + b'4') as char),
                        KeyModifiers::CONTROL | KeyModifiers::ALT,
                    ),
                    0x00 => (
                        KeyCode::Char(' '),
                        KeyModifiers::CONTROL | KeyModifiers::ALT,
                    ),
                    c => {
                        let ch = char::from_u32(u32::from(c)).expect("ascii corpus");
                        let mut modifiers = KeyModifiers::ALT;
                        if ch.is_uppercase() {
                            modifiers |= KeyModifiers::SHIFT;
                        }
                        (KeyCode::Char(ch), modifiers)
                    }
                };
                ModelParse::Event(Event::Key(KeyEvent::new(code, modifiers)))
            }
        }
    }

    /// The report a run must produce: the SGR decode filtered through the
    /// dispatch filter both paths share (`mouse::from_crossterm` consumes
    /// hover motion and the non-left buttons).
    fn expected_report(report: &str) -> Vec<Report> {
        crate::mouse::parse_sgr_mouse_event(report)
            .filter(|r| {
                matches!(
                    r.button,
                    mouse::BUTTON_LEFT | mouse::WHEEL_UP | mouse::WHEEL_DOWN
                )
            })
            .into_iter()
            .collect()
    }

    /// The live defect this port fixes (run 2026-09-22, raw-pty probe):
    /// crossterm's `char_code_to_event` adds SHIFT to uppercase bytes, so
    /// the report's final `M` arrives as `Char('M', SHIFT)` — a rejected
    /// continuation dropped the whole held sequence and leaked the `M`.
    #[test]
    fn a_report_final_m_arriving_shifted_still_decodes() {
        let events = vec![
            esc_press(),
            char_press('['),
            char_press('<'),
            char_press('0'),
            char_press(';'),
            char_press('1'),
            char_press('3'),
            char_press(';'),
            char_press('2'),
            Event::Key(KeyEvent::new(KeyCode::Char('M'), KeyModifiers::SHIFT)),
        ];
        let outputs = run_guard(events);
        assert_eq!(
            reports(&outputs),
            vec![mouse::parse_sgr_mouse_event("\x1b[<0;13;2M").expect("valid report")]
        );
        assert!(leaks(&outputs).is_empty());
    }

    /// THE RACE, MADE DETERMINISTIC: a read ending right after the `ESC`
    /// byte of a drag report makes crossterm commit an `Esc` press and
    /// then type the report's body — the "random escape sequences" Kevin
    /// sees while selecting. Through the guard the same bytes arrive as
    /// exactly the mouse report the terminal sent. Every byte-offset
    /// split of every report form is the fuzz: always the report, never
    /// text.
    #[test]
    fn the_committed_esc_split_never_leaks_a_report() {
        for report in report_corpus() {
            for split in 1..report.len() {
                let events = read_projection(report.as_bytes(), &[split]);
                let outputs = run_guard(events.clone());
                assert_eq!(
                    reports(&outputs),
                    expected_report(&report),
                    "report {report:?} split at {split}: leaked {events:?} as {outputs:?}"
                );
                assert!(
                    leaks(&outputs).is_empty(),
                    "report {report:?} split at {split}: text leak {outputs:?}"
                );
            }
        }
    }

    /// Unsplit reports pass through untouched (the guard is invisible
    /// when nothing splits).
    #[test]
    fn whole_reports_pass_through_as_the_terminal_sent_them() {
        for report in report_corpus() {
            let events = read_projection(report.as_bytes(), &[]);
            let outputs = run_guard(events);
            assert_eq!(reports(&outputs), expected_report(&report));
            assert!(leaks(&outputs).is_empty());
        }
    }

    /// A drag stream with one committed-`ESC` boundary inside one report:
    /// the whole run still arrives as the ordered report sequence, so a
    /// selection drag is never interrupted by stray text.
    #[test]
    fn a_drag_burst_with_one_bad_boundary_stays_a_selection() {
        let stream: String = [
            sgr(0, 13, 2, true),
            sgr(32, 14, 2, true),
            sgr(32, 15, 3, true),
            sgr(32, 16, 3, true),
            sgr(0, 16, 3, false),
        ]
        .concat();
        // The boundary lands after the drag report's `ESC`.
        let second_start = stream.find("\x1b[<32;14;2").expect("drag report in stream");
        let events = read_projection(stream.as_bytes(), &[second_start + 1]);
        let outputs = run_guard(events);
        let expected: Vec<Report> = stream
            .split("\x1b[<")
            .filter(|part| !part.is_empty())
            .map(|part| format!("\x1b[<{part}"))
            .filter_map(|report| crate::mouse::parse_sgr_mouse_event(&report))
            .collect();
        assert_eq!(reports(&outputs), expected);
        assert!(leaks(&outputs).is_empty());
    }

    /// The same split, doubled: the report body itself spans three reads.
    #[test]
    fn a_report_split_across_three_reads_still_decodes() {
        let report = sgr(32, 20, 5, true);
        let mid = report.find(';').expect("field separator");
        let events = read_projection(report.as_bytes(), &[1, mid, mid + 3]);
        let outputs = run_guard(events);
        assert_eq!(
            reports(&outputs),
            vec![crate::mouse::parse_sgr_mouse_event(&report).expect("valid report")]
        );
        assert!(leaks(&outputs).is_empty());
    }

    // -- held Esc behavior ----------------------------------------------

    #[test]
    fn a_held_esc_flushes_as_the_key_press_at_the_deadline() {
        let mut guard = SequenceGuard::default();
        let now = Instant::now();
        assert!(guard.feed(esc_press(), now).is_empty());
        assert!(guard
            .flush_expired(now + HOLD - Duration::from_millis(1))
            .is_empty());
        assert_eq!(
            guard.flush_expired(now + HOLD),
            vec![GuardOutput::Event(esc_press())]
        );
    }

    #[test]
    fn esc_then_a_character_within_the_window_is_the_alt_combo() {
        // crossterm's single-read parse of `\x1ba`: alt+a.
        let mut guard = SequenceGuard::default();
        let now = Instant::now();
        assert!(guard.feed(esc_press(), now).is_empty());
        let mut expected = KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE);
        expected.modifiers |= KeyModifiers::ALT;
        assert_eq!(
            guard.feed(char_press('a'), now + Duration::from_millis(1)),
            vec![GuardOutput::Event(Event::Key(expected))]
        );
    }

    #[test]
    fn esc_then_an_unrelated_key_flushes_the_esc_first() {
        let mut guard = SequenceGuard::default();
        let now = Instant::now();
        assert!(guard.feed(esc_press(), now).is_empty());
        let left = Event::Key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE));
        assert_eq!(
            guard.feed(left.clone(), now + Duration::from_millis(1)),
            vec![GuardOutput::Event(esc_press()), GuardOutput::Event(left)]
        );
    }

    #[test]
    fn esc_then_a_mouse_report_flushes_the_esc_and_passes_the_report() {
        let mut guard = SequenceGuard::default();
        let now = Instant::now();
        assert!(guard.feed(esc_press(), now).is_empty());
        let wheel = Event::Mouse(CtMouse {
            kind: CtMouseKind::ScrollUp,
            column: 3,
            row: 4,
            modifiers: KeyModifiers::NONE,
        });
        let outputs = guard.feed(wheel.clone(), now + Duration::from_millis(1));
        assert_eq!(
            leaks(&outputs),
            vec![esc_press()],
            "the held Esc flushes first"
        );
        assert_eq!(
            reports(&outputs),
            vec![mouse::from_crossterm(match &wheel {
                Event::Mouse(mouse) => mouse,
                _ => unreachable!("the fixture is a mouse event"),
            })
            .expect("wheel decodes")]
        );
    }

    #[test]
    fn a_half_assembled_sequence_is_dropped_at_the_deadline_never_typed() {
        let mut guard = SequenceGuard::default();
        let now = Instant::now();
        assert!(guard.feed(esc_press(), now).is_empty());
        for (offset, c) in ['[', '<', '6', '4'].iter().enumerate() {
            assert!(guard
                .feed(
                    char_press(*c),
                    now + Duration::from_millis(offset as u64 + 1)
                )
                .is_empty());
        }
        assert!(guard
            .flush_expired(now + HOLD + Duration::from_millis(4))
            .is_empty());
    }

    #[test]
    fn a_non_keyboard_event_flushes_the_held_esc_first() {
        let mut guard = SequenceGuard::default();
        let now = Instant::now();
        assert!(guard.feed(esc_press(), now).is_empty());
        let resize = Event::Resize(80, 24);
        let outputs = guard.feed(resize.clone(), now + Duration::from_millis(1));
        assert_eq!(
            outputs,
            vec![GuardOutput::Event(esc_press()), GuardOutput::Event(resize)]
        );
    }

    #[test]
    fn poll_timeout_never_waits_past_the_deadline() {
        let guard = SequenceGuard::default();
        let now = Instant::now();
        assert_eq!(guard.poll_timeout(HOLD, now), HOLD);

        let mut guard = SequenceGuard::default();
        assert!(guard.feed(esc_press(), now).is_empty());
        assert_eq!(
            guard.poll_timeout(HOLD, now + Duration::from_millis(6)),
            Duration::from_millis(4)
        );
        assert_eq!(guard.poll_timeout(HOLD, now + HOLD), Duration::ZERO);
    }

    // -- reassembled key sequences --------------------------------------

    #[test]
    fn a_split_arrow_key_arrives_as_the_key() {
        let outputs = run_guard(read_projection(b"\x1b[A", &[1]));
        assert_eq!(
            leaks(&outputs),
            vec![Event::Key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE))]
        );
    }

    #[test]
    fn a_split_modified_nav_key_keeps_its_modifiers() {
        let outputs = run_guard(read_projection(b"\x1b[1;5A", &[1]));
        assert_eq!(
            leaks(&outputs),
            vec![Event::Key(KeyEvent::new(
                KeyCode::Up,
                KeyModifiers::CONTROL
            ))]
        );
    }

    #[test]
    fn a_split_kitty_esc_press_stays_the_escape_key() {
        let outputs = run_guard(read_projection(b"\x1b[27u", &[1]));
        assert_eq!(leaks(&outputs), vec![esc_press()]);
    }

    #[test]
    fn a_split_csi_u_printable_arrives_as_the_character() {
        let outputs = run_guard(read_projection(b"\x1b[97u", &[1]));
        assert_eq!(leaks(&outputs), vec![char_press('a')]);
    }

    #[test]
    fn a_split_x10_mouse_report_decodes() {
        // `ESC [ M Cb Cx Cy` with Cb=0x20 (left press), Cx=0x21, Cy=0x22.
        let stream = [0x1b_u8, b'[', b'M', 0x20, 0x21, 0x22];
        let outputs = run_guard(read_projection(&stream, &[1]));
        assert_eq!(
            reports(&outputs),
            vec![Report {
                button: mouse::BUTTON_LEFT,
                x: 1,
                y: 2,
                press: true,
                motion: false,
                shift: false,
                alt: false,
                ctrl: false,
            }]
        );
        assert!(leaks(&outputs).is_empty());
    }

    /// An OSC reply split at its `ESC` byte is consumed whole — no
    /// `52;c;<base64>` text in the editor.
    #[test]
    fn a_split_osc_reply_is_consumed_whole() {
        let outputs = run_guard(read_projection(b"\x1b]52;c;YWJj\x07", &[1]));
        assert!(leaks(&outputs).is_empty());
        assert!(reports(&outputs).is_empty());
    }

    /// A bracketed-paste marker split at its `ESC` byte is consumed; the
    /// pasted text still flows as the characters it is.
    #[test]
    fn a_split_bracketed_paste_marker_is_consumed_and_the_text_flows() {
        let outputs = run_guard(read_projection(b"\x1b[200~hi", &[1]));
        assert_eq!(leaks(&outputs), vec![char_press('h'), char_press('i')]);
        assert!(reports(&outputs).is_empty());
    }

    /// A paste-end marker split the same way is consumed too.
    #[test]
    fn a_split_bracketed_paste_end_marker_is_consumed() {
        let outputs = run_guard(read_projection(b"\x1b[201~", &[1]));
        assert!(leaks(&outputs).is_empty());
    }

    // -- the review fixes: expiry, rxvt, keypad CSI-u, UTF-8 ALT ------

    /// A continuation arriving after the hold expired is a fresh input,
    /// never an Alt combo: the held `Esc` flushes first (TS's timer fired
    /// before the event landed, and TS never lets a late keystroke join
    /// a flushed buffer).
    #[test]
    fn an_expired_hold_flushes_the_esc_before_the_next_key() {
        let mut guard = SequenceGuard::default();
        let now = Instant::now();
        assert!(guard.feed(esc_press(), now).is_empty());
        assert_eq!(
            guard.feed(char_press('a'), now + HOLD + Duration::from_millis(1)),
            vec![
                GuardOutput::Event(esc_press()),
                GuardOutput::Event(char_press('a')),
            ]
        );
    }

    /// A half-assembled sequence at its deadline drops whole and the late
    /// keystroke passes as text: TS's timer flushes the raw remainder and
    /// its parser drops the escape form.
    #[test]
    fn an_expired_half_assembled_sequence_drops_and_the_key_types() {
        let mut guard = SequenceGuard::default();
        let now = Instant::now();
        assert!(guard.feed(esc_press(), now).is_empty());
        assert!(guard
            .feed(char_press('['), now + Duration::from_millis(1))
            .is_empty());
        assert_eq!(
            guard.feed(char_press('x'), now + HOLD + Duration::from_millis(2)),
            vec![GuardOutput::Event(char_press('x'))]
        );
    }

    /// rxvt mouse reports (`ESC [ cb ; cx ; cy ; M`, mode 1015) decode
    /// through the same dispatch filter as SGR: crossterm's own parse
    /// delivers them as mouse events, so every split of one must decode
    /// the same instead of vanishing or typing its body.
    #[test]
    fn every_split_of_an_rxvt_report_decodes() {
        // `cb ; cx ; cy` fields are the X10 button byte plus 32
        // (parse_csi_rxvt_mouse): 32 is a plain left press, 64 the
        // motion-bit drag form.
        for (stream, motion) in [
            (b"\x1b[32;30;40;M".as_slice(), false),
            (b"\x1b[64;30;40;M".as_slice(), true),
        ] {
            let expected = vec![Report {
                button: mouse::BUTTON_LEFT,
                x: 30,
                y: 40,
                press: true,
                motion,
                shift: false,
                alt: false,
                ctrl: false,
            }];
            for split in 1..stream.len() {
                let events = read_projection(stream, &[split]);
                let outputs = run_guard(events.clone());
                assert_eq!(
                    reports(&outputs),
                    expected,
                    "rxvt report {stream:?} split at {split}: {events:?} as {outputs:?}"
                );
                assert!(
                    leaks(&outputs).is_empty(),
                    "rxvt report {stream:?} split at {split} leaked {outputs:?}"
                );
            }
            // The unsplit form is the same report (the guard is invisible).
            let outputs = run_guard(read_projection(stream, &[]));
            assert_eq!(reports(&outputs), expected);
            assert!(leaks(&outputs).is_empty());
        }
        // Malformed fields decode to nothing, like crossterm's parse.
        let outputs = run_guard(read_projection(b"\x1b[0;0;0M", &[1]));
        assert!(reports(&outputs).is_empty());
        assert!(leaks(&outputs).is_empty());
    }

    /// A split kitty keypad report decodes as the key the unsplit parse
    /// delivers (`CSI 57399u` is keypad-0, `CSI 57414u` keypad Enter)
    /// with the KEYPAD state crossterm stamps on it — not swallowed by
    /// the private-use blanket.
    #[test]
    fn a_split_keypad_csi_u_arrives_as_the_key() {
        let outputs = run_guard(read_projection(b"\x1b[57399u", &[1]));
        assert_eq!(
            leaks(&outputs),
            vec![Event::Key(KeyEvent::new_with_kind_and_state(
                KeyCode::Char('0'),
                KeyModifiers::NONE,
                KeyEventKind::Press,
                KeyEventState::KEYPAD,
            ))]
        );
        let outputs = run_guard(read_projection(b"\x1b[57414u", &[1]));
        assert_eq!(
            leaks(&outputs),
            vec![Event::Key(KeyEvent::new_with_kind_and_state(
                KeyCode::Enter,
                KeyModifiers::NONE,
                KeyEventKind::Press,
                KeyEventState::KEYPAD,
            ))]
        );
        // The rest of the functional range stays consumed (TS drops it
        // too, and no surface dispatches it).
        let outputs = run_guard(read_projection(b"\x1b[57427u", &[1]));
        assert!(leaks(&outputs).is_empty());
        assert!(reports(&outputs).is_empty());
    }

    /// The legacy function-key form `ESC [ [ A` splits at its `ESC`
    /// exactly the way TS's own `StdinBuffer` splits it: the buffer
    /// completes the three-byte prefix `\x1b[[` at its
    /// `isCompleteCsiSequence` boundary (the final byte `[` is in the
    /// 0x40-0x7e range), TS's `parseKey` drops the prefix, and the
    /// trailing byte types as text — so the split path stays TS-exact.
    /// crossterm's unsplit parse holds the prefix for a fourth byte and
    /// delivers F1; that TS/crossterm divergence is the products' own,
    /// and this guard does not widen it either way.
    #[test]
    fn a_split_legacy_function_key_form_stays_ts_exact() {
        let outputs = run_guard(read_projection(b"\x1b[[A", &[1]));
        assert_eq!(
            leaks(&outputs),
            vec![Event::Key(KeyEvent::new(
                KeyCode::Char('A'),
                KeyModifiers::SHIFT
            ))]
        );
        assert!(reports(&outputs).is_empty());
    }

    /// `ESC` + a multi-byte character is the character with ALT: the
    /// guard must reassemble the whole UTF-8 bytes, not drop the combo
    /// for not being an ASCII single byte (crossterm never splits a
    /// character across events, so the tail is always one character).
    #[test]
    fn a_split_alt_modified_character_keeps_the_alt() {
        // Alt+é: `\x1b` then the two UTF-8 bytes of é.
        let outputs = run_guard(read_projection("\x1b\u{e9}".as_bytes(), &[1]));
        assert_eq!(
            leaks(&outputs),
            vec![Event::Key(KeyEvent::new(
                KeyCode::Char('\u{e9}'),
                KeyModifiers::ALT
            ))]
        );
        // Alt+É arrives SHIFT-modified (crossterm adds SHIFT to
        // uppercase characters).
        let outputs = run_guard(read_projection("\x1b\u{c9}".as_bytes(), &[1]));
        assert_eq!(
            leaks(&outputs),
            vec![Event::Key(KeyEvent::new(
                KeyCode::Char('\u{c9}'),
                KeyModifiers::ALT | KeyModifiers::SHIFT
            ))]
        );
    }

    /// `ESC` + a 0x1c-0x1f control byte is Ctrl+4..7 with ALT
    /// (crossterm reports those bytes as `Char('4'..='7')` with
    /// CONTROL): the guard's reverse map must know that row.
    #[test]
    fn a_split_alt_ctrl_digit_reconstructs_the_combo() {
        let outputs = run_guard(read_projection(b"\x1b\x1c", &[1]));
        assert_eq!(
            leaks(&outputs),
            vec![Event::Key(KeyEvent::new(
                KeyCode::Char('4'),
                KeyModifiers::CONTROL | KeyModifiers::ALT
            ))]
        );
    }
}
