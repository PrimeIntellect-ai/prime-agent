//! SGR mouse-report decoding (TS `tui/src/mouse.ts`).
//!
//! Terminals with SGR mouse tracking active report clicks, wheel turns, and
//! drags as `ESC [ < cb ; cx ; cy (M|m)`: `M` for a press (wheel turns and
//! drag motion included), `m` for a release. The low bits of `cb` carry
//! modifiers and a motion flag, so the base button code is the report with
//! those bits cleared. Everything downstream (the transcript scroll
//! dispatch) reasons about the base code only.

/// A decoded SGR mouse report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MouseEvent {
    /// Base SGR button code with modifier and motion bits removed; wheel
    /// up/down are 64/65.
    pub button: u8,
    /// One-based terminal column.
    pub x: u16,
    /// One-based terminal row.
    pub y: u16,
    /// True for SGR `M` reports (press, wheel, or drag), false for release `m`.
    pub press: bool,
    /// Whether the SGR motion bit is set.
    pub motion: bool,
    /// Modifier bits carried by the SGR report.
    pub shift: bool,
    pub alt: bool,
    pub ctrl: bool,
}

/// SGR wheel-up button code.
pub(crate) const WHEEL_UP: u8 = 64;
/// SGR wheel-down button code.
pub(crate) const WHEEL_DOWN: u8 = 65;
/// SGR left-button code.
pub(crate) const BUTTON_LEFT: u8 = 0;

const MODIFIER_SHIFT: u32 = 4;
const MODIFIER_ALT: u32 = 8;
const MODIFIER_CTRL: u32 = 16;
const MOTION_BIT: u32 = 32;

/// Whether `sequence` is a mouse report: an SGR report (`ESC [ <`) or a
/// legacy X10 report (`ESC [ M`). Both are terminal noise downstream, so
/// callers consume them even when tracking is disabled.
pub(crate) fn is_mouse_sequence(sequence: &str) -> bool {
    sequence.starts_with("\x1b[<") || sequence.starts_with("\x1b[M")
}

/// Decode an SGR mouse report. Returns `None` for anything that is not a
/// complete `ESC [ < cb ; cx ; cy (M|m)` sequence.
pub(crate) fn parse_sgr_mouse_event(sequence: &str) -> Option<MouseEvent> {
    let rest = sequence.strip_prefix("\x1b[<")?;
    let final_byte = rest.as_bytes().last()?;
    if !matches!(final_byte, b'M' | b'm') {
        return None;
    }
    let numbers = rest[..rest.len() - 1].split(';').collect::<Vec<_>>();
    if numbers.len() != 3 {
        return None;
    }
    let raw = numbers[0].parse::<u32>().ok()?;
    let x = numbers[1].parse::<u16>().ok()?;
    let y = numbers[2].parse::<u16>().ok()?;
    // x/y are one-based in the report; a zero column/row is malformed.
    if x == 0 || y == 0 {
        return None;
    }
    Some(MouseEvent {
        button: (raw & !(MODIFIER_SHIFT | MODIFIER_ALT | MODIFIER_CTRL | MOTION_BIT)) as u8,
        x,
        y,
        press: *final_byte == b'M',
        motion: (raw & MOTION_BIT) != 0,
        shift: (raw & MODIFIER_SHIFT) != 0,
        alt: (raw & MODIFIER_ALT) != 0,
        ctrl: (raw & MODIFIER_CTRL) != 0,
    })
}

/// Whether the event is a wheel-up turn (a press with the wheel-up code).
pub(crate) fn is_wheel_up(event: &MouseEvent) -> bool {
    event.press && event.button == WHEEL_UP
}

/// Whether the event is a wheel-down turn (a press with the wheel-down code).
pub(crate) fn is_wheel_down(event: &MouseEvent) -> bool {
    event.press && event.button == WHEEL_DOWN
}

/// The wheel-scroll dispatch (TS `WHEEL_SCROLL_LINES`): the transcript
/// delta for a wheel turn, or `None` when the event is not a wheel press.
pub(crate) fn wheel_scroll_delta(event: &MouseEvent) -> Option<isize> {
    if is_wheel_up(event) {
        Some(-WHEEL_SCROLL_LINES)
    } else if is_wheel_down(event) {
        Some(WHEEL_SCROLL_LINES)
    } else {
        None
    }
}

/// Lines the transcript scrolls per wheel turn (TS `TUI.WHEEL_SCROLL_LINES`).
const WHEEL_SCROLL_LINES: isize = 3;

/// A report read back from a crossterm mouse event: wheel turns and
/// left-button presses, drags, and releases — the report classes the TS
/// dispatch reasons about. `None` for other buttons and hover motion:
/// those reports are consumed at the source without a dispatch (the
/// in-frame selection surface is not ported yet).
pub(crate) fn from_crossterm(event: &crossterm::event::MouseEvent) -> Option<MouseEvent> {
    let (button, press, motion) = match event.kind {
        crossterm::event::MouseEventKind::ScrollUp => (WHEEL_UP, true, false),
        crossterm::event::MouseEventKind::ScrollDown => (WHEEL_DOWN, true, false),
        crossterm::event::MouseEventKind::Down(crossterm::event::MouseButton::Left) => {
            (BUTTON_LEFT, true, false)
        }
        crossterm::event::MouseEventKind::Up(crossterm::event::MouseButton::Left) => {
            (BUTTON_LEFT, false, false)
        }
        crossterm::event::MouseEventKind::Drag(crossterm::event::MouseButton::Left) => {
            (BUTTON_LEFT, true, true)
        }
        _ => return None,
    };
    Some(MouseEvent {
        button,
        // crossterm reports zero-based cells; SGR coordinates are 1-based.
        x: event.column + 1,
        y: event.row + 1,
        press,
        motion,
        shift: event
            .modifiers
            .contains(crossterm::event::KeyModifiers::SHIFT),
        alt: event
            .modifiers
            .contains(crossterm::event::KeyModifiers::ALT),
        ctrl: event
            .modifiers
            .contains(crossterm::event::KeyModifiers::CONTROL),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_a_wheel_up_press() {
        let event = parse_sgr_mouse_event("\x1b[<64;20;5M").expect("valid SGR report");
        assert_eq!(
            event,
            MouseEvent {
                button: WHEEL_UP,
                x: 20,
                y: 5,
                press: true,
                motion: false,
                shift: false,
                alt: false,
                ctrl: false,
            }
        );
    }

    #[test]
    fn decodes_a_wheel_down_press() {
        let event = parse_sgr_mouse_event("\x1b[<65;1;1M").expect("valid SGR report");
        assert_eq!(event.button, WHEEL_DOWN);
        assert!(is_wheel_down(&event));
        assert_eq!(wheel_scroll_delta(&event), Some(WHEEL_SCROLL_LINES));
    }

    #[test]
    fn decodes_a_release_report() {
        let event = parse_sgr_mouse_event("\x1b[<0;13;2m").expect("valid SGR report");
        assert_eq!(event.button, BUTTON_LEFT);
        assert!(!event.press);
        assert!(!is_wheel_up(&event) && !is_wheel_down(&event));
        assert_eq!(wheel_scroll_delta(&event), None);
    }

    #[test]
    fn strips_modifier_and_motion_bits_from_the_button_code() {
        // 32 (motion) + 4 (shift) + 64 (wheel up): a shift-dragged wheel
        // turn still reports the base wheel-up code.
        let event = parse_sgr_mouse_event("\x1b[<100;7;9M").expect("valid SGR report");
        assert_eq!(event.button, WHEEL_UP);
        assert!(event.motion);
        assert!(event.shift);
        assert!(!event.alt);
        assert!(!event.ctrl);
        assert!(is_wheel_up(&event));
    }

    #[test]
    fn decodes_ctrl_and_alt_modifiers() {
        // 16 (ctrl) + 8 (alt) + 1 (middle button).
        let event = parse_sgr_mouse_event("\x1b[<25;4;4M").expect("valid SGR report");
        assert_eq!(event.button, 1);
        assert!(event.ctrl);
        assert!(event.alt);
        assert!(!event.motion);
    }

    #[test]
    fn wheel_up_scrolls_three_lines_up() {
        let event = parse_sgr_mouse_event("\x1b[<64;10;10M").expect("valid SGR report");
        assert_eq!(wheel_scroll_delta(&event), Some(-3));
    }

    #[test]
    fn rejects_non_sgr_and_malformed_sequences() {
        assert_eq!(parse_sgr_mouse_event("\x1b[<64;20;5"), None);
        assert_eq!(parse_sgr_mouse_event("\x1b[<64;20M"), None);
        assert_eq!(parse_sgr_mouse_event("\x1b[<;20;5M"), None);
        assert_eq!(parse_sgr_mouse_event("\x1b[<64;0;5M"), None, "zero column");
        assert_eq!(parse_sgr_mouse_event("\x1b[<64;20;0M"), None, "zero row");
        assert_eq!(parse_sgr_mouse_event("\x1b[<64;20;5X"), None);
        assert_eq!(parse_sgr_mouse_event("hello"), None);
        // A legacy X10 report is recognized as a mouse sequence but has no
        // SGR body to decode.
        assert!(is_mouse_sequence("\x1b[M abc"));
        assert_eq!(parse_sgr_mouse_event("\x1b[M abc"), None);
    }

    #[test]
    fn maps_crossterm_wheel_events() {
        let up = crossterm::event::MouseEvent {
            kind: crossterm::event::MouseEventKind::ScrollUp,
            column: 19,
            row: 4,
            modifiers: crossterm::event::KeyModifiers::SHIFT,
        };
        let event = from_crossterm(&up).expect("wheel-up event");
        assert_eq!(event.button, WHEEL_UP);
        assert_eq!((event.x, event.y), (20, 5));
        assert!(event.press);
        assert!(event.shift);
        assert_eq!(wheel_scroll_delta(&event), Some(-3));

        let down = crossterm::event::MouseEvent {
            kind: crossterm::event::MouseEventKind::ScrollDown,
            column: 0,
            row: 0,
            modifiers: crossterm::event::KeyModifiers::NONE,
        };
        let event = from_crossterm(&down).expect("wheel-down event");
        assert_eq!(event.button, WHEEL_DOWN);
        assert_eq!(wheel_scroll_delta(&event), Some(3));
    }

    #[test]
    fn maps_crossterm_left_button_reports() {
        let click = crossterm::event::MouseEvent {
            kind: crossterm::event::MouseEventKind::Down(crossterm::event::MouseButton::Left),
            column: 2,
            row: 2,
            modifiers: crossterm::event::KeyModifiers::NONE,
        };
        let event = from_crossterm(&click).expect("left press");
        assert_eq!(event.button, BUTTON_LEFT);
        assert!(event.press);
        assert!(!event.motion);
        assert_eq!(wheel_scroll_delta(&event), None);

        let drag = crossterm::event::MouseEvent {
            kind: crossterm::event::MouseEventKind::Drag(crossterm::event::MouseButton::Left),
            column: 3,
            row: 2,
            modifiers: crossterm::event::KeyModifiers::NONE,
        };
        let event = from_crossterm(&drag).expect("left drag");
        assert!(event.motion);

        let release = crossterm::event::MouseEvent {
            kind: crossterm::event::MouseEventKind::Up(crossterm::event::MouseButton::Left),
            column: 3,
            row: 2,
            modifiers: crossterm::event::KeyModifiers::NONE,
        };
        let event = from_crossterm(&release).expect("left release");
        assert!(!event.press);

        let other = crossterm::event::MouseEvent {
            kind: crossterm::event::MouseEventKind::Down(crossterm::event::MouseButton::Right),
            column: 1,
            row: 1,
            modifiers: crossterm::event::KeyModifiers::NONE,
        };
        assert_eq!(from_crossterm(&other), None);
    }

    #[test]
    fn recognizes_mouse_sequence_prefixes() {
        assert!(is_mouse_sequence("\x1b[<64;20;5M"));
        assert!(is_mouse_sequence("\x1b[M##"));
        assert!(!is_mouse_sequence("\x1b[A"));
        assert!(!is_mouse_sequence("plain text"));
    }
}
