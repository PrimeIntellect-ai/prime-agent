//! Key identifiers and matching, ported from `packages/tui/src/keys.ts`.
//!
//! Input arrives as crossterm events; we map them to the same string key ids
//! the TS product uses ("ctrl+c", "shift+enter", "alt+left", ...) so
//! `KeybindingsManager` matching behaves identically.
//!
//! The TS decode matrix (`matchesKey`/`parseKey`) runs on raw byte strings,
//! which carry the encoding (kitty CSI-u vs legacy text) as evidence. This
//! layer sees crossterm's parsed events, where some encodings fold to the
//! same event; the mode-aware mappings follow TS where the kitty protocol
//! flag disambiguates, and the irreducible folds are documented divergences
//! (see `ctrl_char_id` and docs/FEATURE_PARITY.md, the term-enhanced-keys
//! rows).

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::crossterm::event as ct;

pub type KeyId = String;

pub fn key_event_to_id(key: &KeyEvent) -> Option<KeyId> {
    if key.kind == ct::KeyEventKind::Release || key.kind == ct::KeyEventKind::Repeat {
        // Release events are filtered (TS wantsKeyRelease opt-in); repeats behave as presses.
        if key.kind == ct::KeyEventKind::Release {
            return None;
        }
    }
    // TS ids support super/hyper/meta combos (keys.ts
    // formatKeyNameWithModifiers) but no TS keybinding binds one, so a
    // TS-keyed binding never matches them. The prompt-editor keybind lane
    // (2026-09-24, documented divergence) binds the macOS Cmd keys: the
    // kitty protocol delivers them as the SUPER modifier, so a
    // SUPER-modified key resolves to its `super+<key>` id — anything
    // unbound still matches nothing. HYPER/META stay undecoded: no
    // binding names one and terminals never deliver the bits on their own.
    if key
        .modifiers
        .intersects(KeyModifiers::HYPER | KeyModifiers::META)
    {
        return None;
    }
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    let shift = key.modifiers.contains(KeyModifiers::SHIFT);
    let super_key = key.modifiers.contains(KeyModifiers::SUPER);
    let base = match key.code {
        KeyCode::Char(c) => {
            if ctrl {
                return Some(ctrl_char_id(c, alt, shift, super_key));
            }
            if super_key {
                // The plain-super identity (macOS Cmd with the kitty
                // protocol delivering it): `super+a` select-all and
                // `super+z` undo style bindings, with shift/alt kept when
                // the terminal sent them.
                let shift_prefix = if shift || c.is_ascii_uppercase() {
                    "shift+"
                } else {
                    ""
                };
                let alt_prefix = if alt { "alt+" } else { "" };
                return Some(format!(
                    "{alt_prefix}{shift_prefix}super+{}",
                    c.to_ascii_lowercase()
                ));
            }
            if alt {
                if c == '\r' || c == '\n' {
                    return Some("alt+enter".into());
                }
                if c == ' ' {
                    return Some("alt+space".into());
                }
                // rxvt-family alt+arrow encodings (TS `LEGACY_SEQUENCE_KEY_IDS`,
                // keys.ts:460: those terminals send ESC p/n/b/f for
                // Option+Up/Down/Left/Right, and TS parseKey maps the byte
                // sequence before its alt+letter fallback). crossterm folds
                // the bytes into the same Char+ALT event a real alt+letter
                // press produces, so the mapping is mode-aware: only while
                // the kitty protocol is inactive (a kitty terminal reports
                // alt+letter natively, which TS also keeps as alt+letter).
                // The word-motion defaults carry alt+b/alt+f alongside
                // alt+left/alt+right, so the visible behavior is unchanged.
                if !crate::enhanced_keys::kitty_active() {
                    match c {
                        'p' => return Some("alt+up".into()),
                        'n' => return Some("alt+down".into()),
                        'b' => return Some("alt+left".into()),
                        'f' => return Some("alt+right".into()),
                        // ESC + uppercase is the rxvt alt+shift+arrow encoding
                        // (TS keys.ts `!_kittyProtocolActive && data ===
                        // "\x1bB"` in the left/right cases): crossterm folds
                        // it into the SHIFT+ALT uppercase event, which TS
                        // matches as the bare arrow identity only.
                        'B' if shift => return Some("alt+left".into()),
                        'F' if shift => return Some("alt+right".into()),
                        _ => {}
                    }
                }
                // Shift+alt+letter: the CSI-u alternate resolves to the
                // produced uppercase char with SHIFT cleared, and a legacy
                // ESC+uppercase carries the SHIFT bit — both are the
                // TS `shift+alt+<letter>` identity (formatParsedKey).
                let prefix = if shift || c.is_ascii_uppercase() {
                    "shift+alt+"
                } else {
                    "alt+"
                };
                return Some(format!("{prefix}{}", c.to_ascii_lowercase()));
            }
            if c == '\r' || c == '\n' {
                if shift {
                    return Some("shift+enter".into());
                }
                return Some("enter".into());
            }
            if c == '\t' {
                return Some(if shift {
                    "shift+tab".into()
                } else {
                    "tab".into()
                });
            }
            if c == ' ' && shift {
                return Some("shift+space".into());
            }
            return Some(c.to_string());
        }
        KeyCode::Enter => {
            // The super prefix keeps Cmd-modified keys their own identity
            // (unbound combos match nothing instead of falling through to
            // the bare action and submitting).
            if super_key {
                let mut s = String::new();
                if shift {
                    s.push_str("shift+");
                }
                if alt {
                    s.push_str("alt+");
                }
                s.push_str("super+enter");
                return Some(s);
            }
            if alt {
                "alt+enter"
            } else if shift {
                "shift+enter"
            } else {
                "enter"
            }
        }
        KeyCode::Tab => {
            if super_key {
                return Some(if shift {
                    "shift+super+tab".into()
                } else {
                    "super+tab".into()
                });
            }
            if shift {
                "shift+tab"
            } else {
                "tab"
            }
        }
        KeyCode::Backspace => {
            if super_key {
                return Some(match (ctrl, alt) {
                    (true, true) => "ctrl+alt+super+backspace".into(),
                    (true, false) => "ctrl+super+backspace".into(),
                    (false, true) => "alt+super+backspace".into(),
                    (false, false) => "super+backspace".into(),
                });
            }
            if alt {
                "alt+backspace"
            } else if ctrl {
                // ctrl+backspace: TS maps raw 0x08 to backspace except Windows Terminal.
                return Some("ctrl+backspace".into());
            } else {
                "backspace"
            }
        }
        KeyCode::Esc => {
            if super_key {
                return Some("super+escape".into());
            }
            "escape"
        }
        KeyCode::Left => return Some(modified_name("left", ctrl, alt, shift, super_key)),
        KeyCode::Right => return Some(modified_name("right", ctrl, alt, shift, super_key)),
        KeyCode::Up => return Some(modified_name("up", ctrl, alt, shift, super_key)),
        KeyCode::Down => return Some(modified_name("down", ctrl, alt, shift, super_key)),
        KeyCode::Home => return Some(modified_name("home", ctrl, alt, shift, super_key)),
        KeyCode::End => return Some(modified_name("end", ctrl, alt, shift, super_key)),
        KeyCode::PageUp => return Some(modified_name("pageUp", ctrl, alt, shift, super_key)),
        KeyCode::PageDown => return Some(modified_name("pageDown", ctrl, alt, shift, super_key)),
        KeyCode::Delete => return Some(modified_name("delete", ctrl, alt, shift, super_key)),
        KeyCode::Insert => return Some(modified_name("insert", ctrl, alt, shift, super_key)),
        KeyCode::F(n) => return Some(modified_name(&format!("f{n}"), ctrl, alt, shift, super_key)),
        KeyCode::BackTab => {
            if super_key {
                return Some(if alt {
                    "shift+alt+super+tab".into()
                } else {
                    "shift+super+tab".into()
                });
            }
            if alt {
                // The merged meta-wrapped `ESC ESC [ Z` (Option+Shift+Tab with
                // option-as-meta): TS's double-ESC branch strips alt and
                // matches the rest, so the wrapped identity keeps the ALT.
                return Some("shift+alt+tab".into());
            }
            return Some("shift+tab".into());
        }
        KeyCode::Null
        | KeyCode::CapsLock
        | KeyCode::ScrollLock
        | KeyCode::NumLock
        | KeyCode::PrintScreen
        | KeyCode::Pause
        | KeyCode::Menu
        | KeyCode::KeypadBegin
        | KeyCode::Modifier(_)
        | KeyCode::Media(_) => {
            return None;
        }
    };
    Some(base.to_string())
}

/// The ctrl-modified character identities (TS parseKey/formatParsedKey):
///
/// - Shift+ctrl/alt+letter: the kitty CSI-u shifted alternate resolves to
///   the produced uppercase char with SHIFT cleared by crossterm's parser,
///   and the no-alternate form keeps the SHIFT bit; both report the TS
///   `shift+ctrl+<letter>` identity (the bound `shift+ctrl+o` tree filter).
/// - Raw LF: crossterm parses it as Ctrl+J because the app runs raw mode.
///   TS maps `\n` to shift+enter while the kitty protocol is active
///   (Ghostty's `shift+enter=text:\n` mapping) and to enter otherwise
///   (a legacy LF is an Enter). A real Ctrl+J under kitty is the same
///   crossterm event as Ghostty's mapping, so it inserts the newline
///   (TS leaves the CSI-u Ctrl+J unbound — documented divergence).
/// - The xterm 0x1c-0x1f control-byte complement: crossterm folds it into
///   `Char('4'..='7') + CTRL`, but TS keeps the literal ids (`\x1c` is
///   "ctrl+\\", `\x1d` is "ctrl+]", `\x1f` is "ctrl+-"; `ctrl+]` and
///   `ctrl+-` are bound in the editor). The remap stays legacy-only:
///   under the kitty protocol the same Char+CTRL events are the real
///   CSI-u ctrl+digit keys.
fn ctrl_char_id(c: char, alt: bool, shift: bool, super_key: bool) -> String {
    let lower = c.to_ascii_lowercase();
    let shifted = shift || c.is_ascii_uppercase();
    let super_prefix = if super_key { "super+" } else { "" };
    if shifted {
        return if alt {
            format!("shift+ctrl+alt+{super_prefix}{lower}")
        } else {
            format!("shift+ctrl+{super_prefix}{lower}")
        };
    }
    if !alt && lower == 'j' {
        return if super_key {
            if crate::enhanced_keys::kitty_active() {
                "shift+super+enter".to_string()
            } else {
                "super+enter".to_string()
            }
        } else if crate::enhanced_keys::kitty_active() {
            "shift+enter".to_string()
        } else {
            "enter".to_string()
        };
    }
    if alt {
        return format!("ctrl+alt+{super_prefix}{lower}");
    }
    if !crate::enhanced_keys::kitty_active() {
        match lower {
            '4' => return "ctrl+\\".to_string(),
            '5' => return "ctrl+]".to_string(),
            '7' => return "ctrl+-".to_string(),
            _ => {}
        }
    }
    format!("ctrl+{super_prefix}{lower}")
}

fn modified_name(name: &str, ctrl: bool, alt: bool, shift: bool, super_key: bool) -> String {
    let mut s = String::new();
    if shift {
        s.push_str("shift+");
    }
    if ctrl {
        s.push_str("ctrl+");
    }
    if alt {
        s.push_str("alt+");
    }
    if super_key {
        s.push_str("super+");
    }
    s.push_str(name);
    s
}

/// Repeated escape presses arrive as separate events; TS splits combined data.
/// Kept for API parity with CustomEditor.splitRepeatedKeybinding.
pub fn split_repeated(data: &[KeyId], keybinding_id: &str) -> Option<Vec<KeyId>> {
    let hits: Vec<KeyId> = data
        .iter()
        .filter(|k| k.as_str() == keybinding_id)
        .cloned()
        .collect();
    if hits.len() > 1 {
        Some(hits)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

    /// Shift-modified printables must reach the editor as their produced
    /// character. The kitty protocol's `report alternate keys` flag makes
    /// the terminal carry the shifted character (`shift+=` arrives as
    /// `CSI 61:43;2u`), and crossterm's CSI-u parser resolves it to
    /// `Char('+')` with SHIFT cleared before this layer sees the event.
    #[test]
    fn shifted_printables_map_to_the_produced_character() {
        // (produced char, the CSI-u alternate form a kitty terminal sends):
        // shift+1 `CSI 49:33;2u`, shift+/ `CSI 47:63;2u`,
        // shift+' `CSI 39:34;2u`, shift+= `CSI 61:43;2u`,
        // shift+; `CSI 59:58;2u` — the full dogfooded range.
        let range = [
            ('!', "49:33"),
            ('?', "47:63"),
            ('"', "39:34"),
            ('+', "61:43"),
            (':', "59:58"),
        ];
        for (produced, sequence) in range {
            let event = KeyEvent::new(KeyCode::Char(produced), KeyModifiers::NONE);
            let id = key_event_to_id(&event);
            assert_eq!(
                id.as_deref(),
                Some(produced.to_string().as_str()),
                "shifted range item `{sequence}`"
            );
        }
    }

    /// A kitty CSI-u event WITHOUT the shifted alternate (`CSI 61;2u` —
    /// no `report alternate keys`) arrives as the base key plus SHIFT;
    /// the id keeps the base character (TS `decodeKittyPrintable` falls
    /// back to the reported codepoint the same way).
    #[test]
    fn shift_modified_base_key_keeps_the_base_character() {
        let event = KeyEvent::new(KeyCode::Char('='), KeyModifiers::SHIFT);
        assert_eq!(key_event_to_id(&event).as_deref(), Some("="));
    }

    /// The shifted range inserts through the editor: each event decodes to
    /// the produced character and lands in the buffer (the dogfood class —
    /// a shifted key that produced NOTHING — regresses here).
    #[test]
    fn editor_inserts_the_full_shifted_range() {
        let mut editor = crate::editor::Editor::new();
        for (produced, _) in [
            ('+', "61:43"),
            ('!', "49:33"),
            ('?', "47:63"),
            ('"', "39:34"),
            (':', "59:58"),
        ] {
            let event = KeyEvent::new(KeyCode::Char(produced), KeyModifiers::NONE);
            let Some(id) = key_event_to_id(&event) else {
                panic!("shifted key {produced:?} dropped at the id layer");
            };
            editor.handle_input(&id);
        }
        assert_eq!(editor.get_text(), "+!?\":");
    }

    /// The kitty event-type matrix (keys.ts:505): a repeat behaves as a
    /// press, a release is dropped — `CSI 97;1:2u` and `CSI 97;1:3u` are
    /// the crossterm kinds Repeat/Release.
    #[test]
    fn kitty_repeats_press_and_releases_are_dropped() {
        let press = KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE);
        let repeat = KeyEvent::new_with_kind(
            KeyCode::Char('a'),
            KeyModifiers::NONE,
            ct::KeyEventKind::Repeat,
        );
        let release = KeyEvent::new_with_kind(
            KeyCode::Char('a'),
            KeyModifiers::NONE,
            ct::KeyEventKind::Release,
        );
        assert_eq!(key_event_to_id(&press).as_deref(), Some("a"));
        assert_eq!(key_event_to_id(&repeat).as_deref(), Some("a"));
        assert_eq!(key_event_to_id(&release), None);
        // The dedicated key classes too (arrows and function keys carry
        // the event type the same way: `CSI 1;1:3A`, `CSI 3;1:3~`).
        let up_release =
            KeyEvent::new_with_kind(KeyCode::Up, KeyModifiers::NONE, ct::KeyEventKind::Release);
        let delete_release = KeyEvent::new_with_kind(
            KeyCode::Delete,
            KeyModifiers::NONE,
            ct::KeyEventKind::Release,
        );
        assert_eq!(key_event_to_id(&up_release), None);
        assert_eq!(key_event_to_id(&delete_release), None);
    }

    /// The shift+ctrl/alt+letter kitty identities (keys.ts:788): the CSI-u
    /// alternate resolves to the produced uppercase char with SHIFT
    /// cleared (`shift+ctrl+o` arrives as Char('O')+CTRL), and the
    /// no-alternate form keeps the SHIFT bit (`CSI 111;5u` is
    /// Char('o')+CTRL+SHIFT). Both report `shift+ctrl+o` — the bound
    /// tree-filter id — and never fold into the wrong `ctrl+o`.
    #[test]
    fn shift_ctrl_and_alt_letters_report_the_shifted_identity() {
        // `CSI 111:79;5u` (alternate form): SHIFT consumed by crossterm.
        let alternate = KeyEvent::new(KeyCode::Char('O'), KeyModifiers::CONTROL);
        assert_eq!(key_event_to_id(&alternate).as_deref(), Some("shift+ctrl+o"));
        // `CSI 111;5u` (no alternate): SHIFT bit still present.
        let plain = KeyEvent::new(
            KeyCode::Char('o'),
            KeyModifiers::CONTROL | KeyModifiers::SHIFT,
        );
        assert_eq!(key_event_to_id(&plain).as_deref(), Some("shift+ctrl+o"));
        // Alt combos take the same shift-first identity (formatParsedKey).
        let alt_shift = KeyEvent::new(KeyCode::Char('o'), KeyModifiers::ALT | KeyModifiers::SHIFT);
        assert_eq!(key_event_to_id(&alt_shift).as_deref(), Some("shift+alt+o"));
        // A plain ctrl+letter keeps its id.
        let ctrl_o = KeyEvent::new(KeyCode::Char('o'), KeyModifiers::CONTROL);
        assert_eq!(key_event_to_id(&ctrl_o).as_deref(), Some("ctrl+o"));
        // Legacy ESC+uppercase carries the SHIFT bit: `\x1bA` is
        // shift+alt+a, TS parity (never plain "alt+a").
        let esc_a = KeyEvent::new(KeyCode::Char('A'), KeyModifiers::ALT | KeyModifiers::SHIFT);
        assert_eq!(key_event_to_id(&esc_a).as_deref(), Some("shift+alt+a"));
    }

    /// The bound editor keys that live on xterm's 0x1c-0x1f control-byte
    /// complement (keys.ts parseKey: `\x1d` -> "ctrl+]", `\x1f` ->
    /// "ctrl+-"): crossterm folds the bytes into Char('4'..='7')+CTRL,
    /// so the legacy ids are restored when the kitty protocol is not
    /// active; under kitty the same events are the real ctrl+digit keys.
    #[test]
    fn legacy_control_byte_complement_keeps_the_literal_ids() {
        // The kitty flag is process-global: serialize through the
        // enhanced-keys module's state lock pattern.
        let _guard = crate::enhanced_keys::TEST_STATE_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        crate::enhanced_keys::set_kitty_active_for_tests(false);
        let ctrl_bracket = KeyEvent::new(KeyCode::Char('5'), KeyModifiers::CONTROL);
        assert_eq!(key_event_to_id(&ctrl_bracket).as_deref(), Some("ctrl+]"));
        let ctrl_underscore = KeyEvent::new(KeyCode::Char('7'), KeyModifiers::CONTROL);
        assert_eq!(key_event_to_id(&ctrl_underscore).as_deref(), Some("ctrl+-"));
        let ctrl_backslash = KeyEvent::new(KeyCode::Char('4'), KeyModifiers::CONTROL);
        assert_eq!(key_event_to_id(&ctrl_backslash).as_deref(), Some("ctrl+\\"));
        // Under the kitty protocol the same event is the real ctrl+digit
        // (`CSI 53;5u`), which TS leaves on the digit id.
        crate::enhanced_keys::set_kitty_active_for_tests(true);
        assert_eq!(key_event_to_id(&ctrl_bracket).as_deref(), Some("ctrl+5"));
        crate::enhanced_keys::set_kitty_active_for_tests(false);
    }

    /// The LF mapping is kitty-mode-aware (keys.ts parseKey): raw LF is
    /// crossterm's Ctrl+J because the app runs raw mode. TS maps it to
    /// shift+enter under kitty (Ghostty's `shift+enter=text:\n`) and to
    /// enter in legacy mode (a legacy LF is an Enter).
    #[test]
    fn raw_lf_maps_by_kitty_mode() {
        let _guard = crate::enhanced_keys::TEST_STATE_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let ctrl_j = KeyEvent::new(KeyCode::Char('j'), KeyModifiers::CONTROL);
        crate::enhanced_keys::set_kitty_active_for_tests(true);
        assert_eq!(key_event_to_id(&ctrl_j).as_deref(), Some("shift+enter"));
        crate::enhanced_keys::set_kitty_active_for_tests(false);
        assert_eq!(key_event_to_id(&ctrl_j).as_deref(), Some("enter"));
        // ctrl+alt+j keeps its own id (the legacy `\x1b\n` form).
        let ctrl_alt_j = KeyEvent::new(
            KeyCode::Char('j'),
            KeyModifiers::CONTROL | KeyModifiers::ALT,
        );
        assert_eq!(key_event_to_id(&ctrl_alt_j).as_deref(), Some("ctrl+alt+j"));
    }

    /// Super-modified SPECIAL keys keep their super identity (Bugbot
    /// round-1 fix): an unbound Cmd combo must match nothing instead of
    /// falling through to the bare action — Cmd+Enter submitting the
    /// prompt or Cmd+Backspace deleting a character would be surprising.
    #[test]
    fn super_modified_special_keys_keep_their_identity() {
        let _guard = crate::enhanced_keys::TEST_STATE_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        crate::enhanced_keys::set_kitty_active_for_tests(false);
        let cases = [
            (KeyCode::Enter, KeyModifiers::SUPER, "super+enter"),
            (
                KeyCode::Enter,
                KeyModifiers::SUPER | KeyModifiers::SHIFT,
                "shift+super+enter",
            ),
            (KeyCode::Backspace, KeyModifiers::SUPER, "super+backspace"),
            (
                KeyCode::Backspace,
                KeyModifiers::SUPER | KeyModifiers::CONTROL,
                "ctrl+super+backspace",
            ),
            (KeyCode::Tab, KeyModifiers::SUPER, "super+tab"),
            (KeyCode::Esc, KeyModifiers::SUPER, "super+escape"),
            (KeyCode::BackTab, KeyModifiers::SUPER, "shift+super+tab"),
            (
                KeyCode::Char('j'),
                KeyModifiers::CONTROL | KeyModifiers::SUPER,
                "super+enter",
            ),
        ];
        for (code, modifiers, expected) in cases {
            let event = KeyEvent::new(code, modifiers);
            assert_eq!(key_event_to_id(&event).as_deref(), Some(expected));
        }
        // None of them reach the bare actions.
        let kb = crate::keybindings::KeybindingsManager::new();
        for id in ["super+enter", "shift+super+enter", "super+backspace"] {
            assert!(
                !kb.matches(id, "tui.input.submit"),
                "{id} must not submit the prompt"
            );
            assert!(
                !kb.matches(id, "tui.editor.deleteCharBackward"),
                "{id} must not delete"
            );
            assert!(
                !kb.matches(id, "app.input.clear"),
                "{id} must not trigger the escape ladder"
            );
        }
    }

    /// Shift+tab keeps its TS id (`\x1b[Z` -> "shift+tab"; crossterm
    /// calls it BackTab) even though no keybinding binds it.
    #[test]
    fn backtab_reports_shift_tab() {
        let backtab = KeyEvent::new(KeyCode::BackTab, KeyModifiers::NONE);
        assert_eq!(key_event_to_id(&backtab).as_deref(), Some("shift+tab"));
    }

    /// rxvt-family alt+arrow encodings (TS `LEGACY_SEQUENCE_KEY_IDS`,
    /// keys.ts:460): those terminals send ESC p/n/b/f for
    /// Option+Up/Down/Left/Right, and TS parseKey maps the byte sequence
    /// BEFORE its alt+letter fallback. crossterm folds the bytes into the
    /// same Char+ALT event a real alt+letter press produces, so the
    /// mapping is mode-aware (kitty terminals report alt+letter natively).
    #[test]
    fn rxvt_alt_arrow_folds_map_to_arrows_outside_kitty() {
        let _guard = crate::enhanced_keys::TEST_STATE_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        crate::enhanced_keys::set_kitty_active_for_tests(false);
        let alt = |c: char, shift: bool| {
            let mut modifiers = KeyModifiers::ALT;
            if shift {
                modifiers |= KeyModifiers::SHIFT;
            }
            KeyEvent::new(KeyCode::Char(c), modifiers)
        };
        assert_eq!(key_event_to_id(&alt('p', false)).as_deref(), Some("alt+up"));
        assert_eq!(
            key_event_to_id(&alt('n', false)).as_deref(),
            Some("alt+down")
        );
        assert_eq!(
            key_event_to_id(&alt('b', false)).as_deref(),
            Some("alt+left")
        );
        assert_eq!(
            key_event_to_id(&alt('f', false)).as_deref(),
            Some("alt+right")
        );
        // ESC + uppercase (\x1bB / \x1bF): TS matches these ONLY as the
        // bare arrow (keys.ts left/right cases); a real alt+shift+letter
        // press folds into the same event on legacy terminals.
        assert_eq!(
            key_event_to_id(&alt('B', true)).as_deref(),
            Some("alt+left")
        );
        assert_eq!(
            key_event_to_id(&alt('F', true)).as_deref(),
            Some("alt+right")
        );
        // Other uppercase folds keep the TS shift+alt+letter identity (TS
        // matches nothing for them).
        assert_eq!(
            key_event_to_id(&alt('D', true)).as_deref(),
            Some("shift+alt+d")
        );

        crate::enhanced_keys::set_kitty_active_for_tests(true);
        // Under the kitty protocol the same events are the real combos.
        assert_eq!(key_event_to_id(&alt('p', false)).as_deref(), Some("alt+p"));
        assert_eq!(
            key_event_to_id(&alt('B', true)).as_deref(),
            Some("shift+alt+b")
        );
        crate::enhanced_keys::set_kitty_active_for_tests(false);
    }

    /// The merged meta-wrapped `ESC ESC [ Z` (Option+Shift+Tab with
    /// option-as-meta) arrives as ALT+BackTab: the id keeps the ALT (TS's
    /// double-ESC branch strips alt and matches `\x1b[Z` as shift+tab).
    #[test]
    fn backtab_keeps_the_alt_identity() {
        let plain = KeyEvent::new(KeyCode::BackTab, KeyModifiers::NONE);
        let wrapped = KeyEvent::new(KeyCode::BackTab, KeyModifiers::ALT);
        assert_eq!(key_event_to_id(&plain).as_deref(), Some("shift+tab"));
        assert_eq!(key_event_to_id(&wrapped).as_deref(), Some("shift+alt+tab"));
    }

    /// The macOS Cmd keys arrive as the SUPER modifier under the kitty
    /// protocol (prompt-editor-keybinds): every identity keeps its `super+`
    /// prefix so the Cmd bindings (undo/redo, select-all, line and doc
    /// jumps, cut/copy) match — an unbound one still matches nothing.
    #[test]
    fn super_modified_keys_decode_to_super_ids() {
        let cases = [
            (
                KeyCode::Char('z'),
                KeyModifiers::SUPER,
                "super+z",
                "Cmd+Z undo",
            ),
            (
                // A kitty terminal reports Cmd+Shift+Z through the shifted
                // alternate: crossterm resolves it to Char('Z') with SHIFT
                // cleared, so the id carries the shift from the produced
                // character.
                KeyCode::Char('Z'),
                KeyModifiers::SUPER,
                "shift+super+z",
                "Cmd+Shift+Z redo family",
            ),
            (
                KeyCode::Left,
                KeyModifiers::SUPER,
                "super+left",
                "Cmd+Left line start",
            ),
            (
                KeyCode::Up,
                KeyModifiers::SUPER,
                "super+up",
                "Cmd+Up doc start",
            ),
            (
                KeyCode::Home,
                KeyModifiers::CONTROL,
                "ctrl+home",
                "Ctrl+Home doc start",
            ),
            (
                KeyCode::Down,
                KeyModifiers::SUPER | KeyModifiers::SHIFT,
                "shift+super+down",
                "Cmd+Shift+Down select to doc end",
            ),
        ];
        for (code, modifiers, expected, what) in cases {
            let event = KeyEvent::new(code, modifiers);
            assert_eq!(key_event_to_id(&event).as_deref(), Some(expected), "{what}");
        }
        // The new ids resolve against the registry defaults.
        let kb = crate::keybindings::KeybindingsManager::new();
        assert!(kb.matches("super+z", "tui.editor.undo"));
        assert!(kb.matches("ctrl+shift+z", "tui.editor.redo"));
        assert!(kb.matches("shift+super+z", "tui.editor.redo"));
        // A ctrl+super combo (Cmd+Ctrl+Shift+Z) is its own identity: it
        // matches nothing (no binding names all three modifiers).
        assert!(!kb.matches("shift+ctrl+super+z", "tui.editor.redo"));
        assert!(kb.matches("super+a", "tui.editor.selectAll"));
        assert!(kb.matches("super+left", "tui.editor.cursorLineStart"));
        assert!(kb.matches("super+right", "tui.editor.cursorLineEnd"));
        assert!(kb.matches("super+up", "tui.editor.cursorDocStart"));
        assert!(kb.matches("super+down", "tui.editor.cursorDocEnd"));
        assert!(kb.matches("ctrl+up", "tui.editor.cursorParagraphUp"));
        assert!(kb.matches("ctrl+down", "tui.editor.cursorParagraphDown"));
        assert!(kb.matches("shift+super+down", "tui.editor.selectDocEnd"));
        assert!(kb.matches("super+x", "tui.editor.cutSelection"));
        assert!(kb.matches("super+c", "tui.editor.copySelection"));
        // The shift+arrow selection families.
        assert!(kb.matches("shift+left", "tui.editor.selectLeft"));
        assert!(kb.matches("shift+up", "tui.editor.selectUp"));
        assert!(kb.matches("shift+ctrl+left", "tui.editor.selectWordLeft"));
        assert!(kb.matches("shift+home", "tui.editor.selectLineStart"));
        assert!(kb.matches("shift+ctrl+home", "tui.editor.selectDocStart"));
    }
}
