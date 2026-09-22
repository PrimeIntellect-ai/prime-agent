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
    if key
        .modifiers
        .intersects(KeyModifiers::SUPER | KeyModifiers::HYPER | KeyModifiers::META)
    {
        // TS ids support super/hyper/meta combos but no keybinding binds
        // one (keys.ts formatKeyNameWithModifiers); a super-modified key
        // matches nothing instead of falling through to the bare key.
        return None;
    }
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    let shift = key.modifiers.contains(KeyModifiers::SHIFT);
    let base = match key.code {
        KeyCode::Char(c) => {
            if ctrl {
                return Some(ctrl_char_id(c, alt, shift));
            }
            if alt {
                if c == '\r' || c == '\n' {
                    return Some("alt+enter".into());
                }
                if c == ' ' {
                    return Some("alt+space".into());
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
            if alt {
                "alt+enter"
            } else if shift {
                "shift+enter"
            } else {
                "enter"
            }
        }
        KeyCode::Tab => {
            if shift {
                "shift+tab"
            } else {
                "tab"
            }
        }
        KeyCode::Backspace => {
            if alt {
                "alt+backspace"
            } else if ctrl {
                // ctrl+backspace: TS maps raw 0x08 to backspace except Windows Terminal.
                return Some("ctrl+backspace".into());
            } else {
                "backspace"
            }
        }
        KeyCode::Esc => "escape",
        KeyCode::Left => return Some(modified_name("left", ctrl, alt, shift)),
        KeyCode::Right => return Some(modified_name("right", ctrl, alt, shift)),
        KeyCode::Up => return Some(modified_name("up", ctrl, alt, shift)),
        KeyCode::Down => return Some(modified_name("down", ctrl, alt, shift)),
        KeyCode::Home => return Some(modified_name("home", ctrl, alt, shift)),
        KeyCode::End => return Some(modified_name("end", ctrl, alt, shift)),
        KeyCode::PageUp => return Some(modified_name("pageUp", ctrl, alt, shift)),
        KeyCode::PageDown => return Some(modified_name("pageDown", ctrl, alt, shift)),
        KeyCode::Delete => return Some(modified_name("delete", ctrl, alt, shift)),
        KeyCode::Insert => return Some(modified_name("insert", ctrl, alt, shift)),
        KeyCode::F(n) => return Some(modified_name(&format!("f{n}"), ctrl, alt, shift)),
        KeyCode::BackTab => return Some("shift+tab".into()),
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
fn ctrl_char_id(c: char, alt: bool, shift: bool) -> String {
    let lower = c.to_ascii_lowercase();
    let shifted = shift || c.is_ascii_uppercase();
    if shifted {
        return if alt {
            format!("shift+ctrl+alt+{lower}")
        } else {
            format!("shift+ctrl+{lower}")
        };
    }
    if !alt && lower == 'j' {
        return if crate::enhanced_keys::kitty_active() {
            "shift+enter".to_string()
        } else {
            "enter".to_string()
        };
    }
    if alt {
        return format!("ctrl+alt+{lower}");
    }
    if !crate::enhanced_keys::kitty_active() {
        match lower {
            '4' => return "ctrl+\\".to_string(),
            '5' => return "ctrl+]".to_string(),
            '7' => return "ctrl+-".to_string(),
            _ => {}
        }
    }
    format!("ctrl+{lower}")
}

fn modified_name(name: &str, ctrl: bool, alt: bool, shift: bool) -> String {
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

    /// Super/hyper/meta combos match nothing (TS supports the ids but no
    /// keybinding binds one); the bare key must not leak through.
    #[test]
    fn super_modified_keys_match_nothing() {
        use KeyModifiers as M;
        let super_k = KeyEvent::new(KeyCode::Char('k'), M::SUPER);
        assert_eq!(key_event_to_id(&super_k), None);
        let super_up = KeyEvent::new(KeyCode::Up, M::SUPER);
        assert_eq!(key_event_to_id(&super_up), None);
        let hyper_a = KeyEvent::new(KeyCode::Char('a'), M::HYPER | M::META);
        assert_eq!(key_event_to_id(&hyper_a), None);
    }

    /// Shift+tab keeps its TS id (`\x1b[Z` -> "shift+tab"; crossterm
    /// calls it BackTab) even though no keybinding binds it.
    #[test]
    fn backtab_reports_shift_tab() {
        let backtab = KeyEvent::new(KeyCode::BackTab, KeyModifiers::NONE);
        assert_eq!(key_event_to_id(&backtab).as_deref(), Some("shift+tab"));
    }
}
