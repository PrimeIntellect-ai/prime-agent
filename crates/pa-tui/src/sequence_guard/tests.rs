use super::*;
use crossterm::event::{MouseEvent as CtMouse, MouseEventKind as CtMouseKind};

fn esc_press() -> Event {
    Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE))
}

fn char_press(c: char) -> Event {
    Event::Key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE))
}

/// The guard's view of a reader run: one feed per event on a 1 ms clock, then one deadline flush.
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

/// The SGR reports a real terminal emits with `?1002` + `?1006` tracking (the battery's classes,
/// plus the reports the dispatch filter consumes).
fn report_corpus() -> Vec<String> {
    vec![
        sgr(0, 13, 2, true),   // left press
        sgr(32, 14, 2, true),  // left drag
        sgr(0, 14, 2, false),  // left release
        sgr(64, 20, 5, true),  // wheel up
        sgr(65, 20, 5, true),  // wheel down
        sgr(0, 100, 30, true), // three-digit coordinates
        sgr(35, 7, 9, true),   // hover motion (the hover affordance's report)
        sgr(1, 3, 4, true),    // middle press (consumed)
    ]
}

/// What leaked as key presses (mouse reports of both shapes are the expected payload instead).
fn leaks(outputs: &[GuardOutput]) -> Vec<Event> {
    outputs
        .iter()
        .filter_map(|out| match out {
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
            GuardOutput::Event(Event::Mouse(mouse)) => mouse::from_crossterm(*mouse),
            GuardOutput::Event(_) => None,
        })
        .collect()
}

// -- the read-boundary defect and its repair ------------------------

/// The events crossterm 0.28.1's reader produces for a byte stream split into OS reads after each
/// `split_after` offset: its parser holds an incomplete sequence across reads and passes `more =
/// read_count == TTY_BUFFER_SIZE`, so a partial read ending on `ESC` commits an `Esc` press; the
/// model covers the forms this lane feeds it.
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

/// crossterm 0.28.1's byte parser, the forms the projection corpus reaches (plain bytes, SGR/X10
/// mouse, CSI keys, kitty CSI-u).
fn model_parse(buf: &[u8], more: bool) -> ModelParse {
    if buf[0] != 0x1b {
        if buf[0] >= 0x80 {
            // `parse_utf8_char`: an incomplete code point keeps buffering, a
            // complete one is the character (SHIFT only on uppercase).
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
                // `ESC [ [ <fin>`: parse_csi holds the three-byte prefix for the fourth byte, then
                // F1-F5 (any other final byte is a dropped parse error).
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
                // rxvt mouse (`parse_csi_rxvt_mouse`): `cb ; cx ; cy` behind
                // a digit-led CSI, `M` at the end.
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
                    let mut fields = text.split(';');
                    let codepoint: u32 = fields.next().expect("non-empty").parse().expect("corpus");
                    // `parse_csi_u_encoded_key_code`: the modifier mask rides
                    // the second field (`CSI 13;2u`).
                    let mut modifiers = KeyModifiers::empty();
                    if let Some(mods) = fields.next() {
                        let mask: u8 = mods
                            .split(':')
                            .next()
                            .unwrap_or_default()
                            .parse()
                            .expect("corpus");
                        modifiers = parse_modifiers(mask);
                    }
                    if (57399..=57426).contains(&codepoint) {
                        // The keypad block decodes with the KEYPAD state.
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
                        return ModelParse::Event(Event::Key(KeyEvent::new_with_kind_and_state(
                            code,
                            KeyModifiers::NONE,
                            KeyEventKind::Press,
                            KeyEventState::KEYPAD,
                        )));
                    }
                    match codepoint {
                        27 => ModelParse::Event(Event::Key(KeyEvent::new(KeyCode::Esc, modifiers))),
                        // `\r` maps to Enter before the char row (crossterm's
                        // own match), so `CSI 13;2u` projects Enter+SHIFT.
                        13 => {
                            ModelParse::Event(Event::Key(KeyEvent::new(KeyCode::Enter, modifiers)))
                        }
                        c => ModelParse::Event(Event::Key(KeyEvent::new(
                            KeyCode::Char(char::from_u32(c).expect("corpus")),
                            modifiers,
                        ))),
                    }
                }
                b'~' if payload == b"27;2;13~" => ModelParse::Event(Event::Key(KeyEvent::new(
                    KeyCode::Enter,
                    KeyModifiers::SHIFT,
                ))),
                b'~' if payload == b"200~" || payload == b"201~" => ModelParse::Invalid,
                _ => ModelParse::Invalid,
            }
        }
        // crossterm's ESC branch re-parses the remaining bytes and adds ALT: control bytes keep
        // their control forms, ASCII and UTF-8 characters are their key.
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
                        ModelParse::Event(Event::Key(KeyEvent::new(KeyCode::Char(ch), modifiers)))
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

/// The SGR decode filtered through the dispatch filter: `mouse::from_crossterm` consumes the
/// non-left buttons; the buttonless hover motion maps through (operator directive 2026-09-26).
fn expected_report(report: &str) -> Vec<Report> {
    crate::mouse::parse_sgr_mouse_event(report)
        .filter(|r| {
            matches!(
                r.button,
                mouse::BUTTON_LEFT | mouse::WHEEL_UP | mouse::WHEEL_DOWN | mouse::BUTTON_NONE
            )
        })
        .into_iter()
        .collect()
}

/// The live defect this port fixes (run 2026-09-22, raw-pty probe): crossterm's
/// `char_code_to_event` adds SHIFT to uppercase bytes, so the report's final `M` arrives as
/// `Char('M', SHIFT)` — a rejected continuation dropped the whole held sequence and leaked the `M`.
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

/// THE RACE, MADE DETERMINISTIC: a read ending right after the `ESC` byte of a drag report makes
/// crossterm commit an `Esc` press and then type the report's body — the "random escape sequences"
/// seen while selecting. Through the guard every byte-offset split of every report form arrives as
/// the report, never text.
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

/// Unsplit reports pass through untouched (the guard is invisible when nothing splits).
#[test]
fn whole_reports_pass_through_as_the_terminal_sent_them() {
    for report in report_corpus() {
        let events = read_projection(report.as_bytes(), &[]);
        let outputs = run_guard(events);
        assert_eq!(reports(&outputs), expected_report(&report));
        assert!(leaks(&outputs).is_empty());
    }
}

/// A drag stream with one committed-`ESC` boundary inside one report still arrives as the ordered
/// report sequence, so a drag is never interrupted by stray text.
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
        .flush_expired((now + HOLD).checked_sub(Duration::from_millis(1)).unwrap())
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
            Event::Mouse(mouse) => *mouse,
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
fn poll_deadline_parks_when_nothing_is_held() {
    let guard = SequenceGuard::default();
    assert_eq!(guard.poll_deadline(Instant::now()), None);
}

#[test]
fn poll_deadline_is_the_remaining_hold() {
    let mut guard = SequenceGuard::default();
    let now = Instant::now();
    assert!(guard.feed(esc_press(), now).is_empty());
    assert_eq!(
        guard.poll_deadline(now + Duration::from_millis(6)),
        Some(Duration::from_millis(4))
    );
    assert_eq!(guard.poll_deadline(now + HOLD), Some(Duration::ZERO));
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

/// An OSC reply split at its `ESC` byte is consumed whole — no `52;c;<base64>` text in the editor.
#[test]
fn a_split_osc_reply_is_consumed_whole() {
    let outputs = run_guard(read_projection(b"\x1b]52;c;YWJj\x07", &[1]));
    assert!(leaks(&outputs).is_empty());
    assert!(reports(&outputs).is_empty());
}

/// A bracketed-paste marker split at its `ESC` byte is consumed; the pasted text still flows as
/// characters.
#[test]
fn a_split_bracketed_paste_marker_is_consumed_and_the_text_flows() {
    let outputs = run_guard(read_projection(b"\x1b[200~hi", &[1]));
    assert_eq!(leaks(&outputs), vec![char_press('h'), char_press('i')]);
    assert!(reports(&outputs).is_empty());
}

#[test]
fn a_split_bracketed_paste_end_marker_is_consumed() {
    let outputs = run_guard(read_projection(b"\x1b[201~", &[1]));
    assert!(leaks(&outputs).is_empty());
}

// -- the review fixes: expiry, rxvt, keypad CSI-u, UTF-8 ALT ------

/// A continuation arriving after the hold expired is a fresh input, never an Alt combo: the held
/// `Esc` flushes first (TS's timer fired before the event landed).
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

/// A half-assembled sequence at its deadline drops whole and the late keystroke passes as text
/// (TS's timer flushes the raw remainder and its parser drops the escape form).
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

/// rxvt mouse reports (`ESC [ cb ; cx ; cy ; M`, mode 1015) decode through the same dispatch filter
/// as SGR: every split must decode the same instead of vanishing or typing its body.
#[test]
fn every_split_of_an_rxvt_report_decodes() {
    // `cb ; cx ; cy` fields are the X10 button byte plus 32: 32 is a plain
    // left press, 64 the motion-bit drag form.
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
        let outputs = run_guard(read_projection(stream, &[]));
        assert_eq!(reports(&outputs), expected);
        assert!(leaks(&outputs).is_empty());
    }
    // Malformed fields decode to nothing, like crossterm's parse.
    let outputs = run_guard(read_projection(b"\x1b[0;0;0M", &[1]));
    assert!(reports(&outputs).is_empty());
    assert!(leaks(&outputs).is_empty());
}

/// A split kitty keypad report decodes as the key the unsplit parse delivers (`CSI 57399u` is
/// keypad-0, `CSI 57414u` keypad Enter) — not swallowed by the private-use blanket.
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
    // The rest of the functional range stays consumed (TS drops it too, and no surface dispatches
    // it).
    let outputs = run_guard(read_projection(b"\x1b[57427u", &[1]));
    assert!(leaks(&outputs).is_empty());
    assert!(reports(&outputs).is_empty());
}

/// The legacy function-key form `ESC [ [ A` splits at its `ESC` the way TS's own `StdinBuffer`
/// splits it: the three-byte prefix completes at `isCompleteCsiSequence`, `parseKey` drops it, and
/// the trailing byte types as text. crossterm's unsplit parse holds the prefix for a fourth byte
/// and delivers F1; that divergence is the products' own, and this guard does not widen it.
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

/// `ESC` + a multi-byte character is the character with ALT: the guard reassembles the whole UTF-8
/// bytes (crossterm never splits a character across events).
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
    // Alt+É arrives SHIFT-modified (crossterm adds SHIFT to uppercase characters).
    let outputs = run_guard(read_projection("\x1b\u{c9}".as_bytes(), &[1]));
    assert_eq!(
        leaks(&outputs),
        vec![Event::Key(KeyEvent::new(
            KeyCode::Char('\u{c9}'),
            KeyModifiers::ALT | KeyModifiers::SHIFT
        ))]
    );
}

/// `ESC` + a 0x1c-0x1f control byte is Ctrl+4..7 with ALT (crossterm reports those bytes as
/// `Char('4'..='7')` with CONTROL): the guard's reverse map must know that row.
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

/// A split kitty shift+enter (`CSI 13;2u`) reassembles into exactly the Enter+SHIFT event the
/// unsplit parse delivers, at every read boundary (operator directive 2026-09-24).
#[test]
fn a_split_kitty_shift_enter_arrives_as_the_shift_enter_key() {
    for split in [1usize, 2, 5, 8] {
        let events = read_projection(b"\x1b[13;2u", &[split]);
        let outputs = run_guard(events.clone());
        assert_eq!(
            leaks(&outputs),
            vec![Event::Key(KeyEvent::new(
                KeyCode::Enter,
                KeyModifiers::SHIFT
            ))],
            "split at {split}: {events:?} as {outputs:?}"
        );
    }

    let outputs = run_guard(vec![Event::Key(KeyEvent::new(
        KeyCode::Enter,
        KeyModifiers::SHIFT,
    ))]);
    assert_eq!(
        leaks(&outputs),
        vec![Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::SHIFT
        ))]
    );
}

#[test]
fn modify_other_keys_shift_enter_survives_every_read_boundary() {
    let input = b"a\x1b[27;2;13~b";
    for split in 0..=input.len() {
        let events = leaks(&run_guard(read_projection(input, &[split])));
        assert_eq!(
            events,
            vec![
                char_press('a'),
                Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::SHIFT)),
                char_press('b'),
            ],
            "split at {split}"
        );
        let mut editor = crate::editor::Editor::new();
        for event in events {
            let Event::Key(key) = event else {
                unreachable!("key events asserted above");
            };
            editor.handle_input(&crate::keys::key_event_to_id(&key).expect("key id"));
        }
        assert_eq!(editor.get_lines(), vec!["a", "b"], "split at {split}");
        assert!(editor
            .take_events()
            .iter()
            .all(|event| !matches!(event, crate::editor::EditorEvent::Submitted(_))));
    }
}

/// The composed seam: a split kitty shift+enter reassembles, decodes to the `shift+enter` key id,
/// and lands in the editor as a newline — never a submit.
#[test]
fn a_split_shift_enter_inserts_a_newline_in_the_editor() {
    let outputs = run_guard(read_projection(b"\x1b[13;2u", &[1]));
    let key = leaks(&outputs)
        .into_iter()
        .find_map(|event| match event {
            Event::Key(key) => Some(key),
            _ => None,
        })
        .expect("the shift+enter key");
    let id = crate::keys::key_event_to_id(&key).expect("the key id");
    assert_eq!(id, "shift+enter");
    let mut editor = crate::editor::Editor::new();
    editor.handle_input("a");
    editor.handle_input(&id);
    assert_eq!(editor.get_lines(), vec!["a", ""]);
    // The newline press carries only its Changed event — a submit never rides along.
    assert!(
        editor
            .take_events()
            .into_iter()
            .all(|event| !matches!(event, crate::editor::EditorEvent::Submitted(_))),
        "the newline press never submits"
    );
}
