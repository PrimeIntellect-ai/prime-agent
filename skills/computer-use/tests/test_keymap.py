"""Tests for computer_use.keymap chord parsing and the keycode table."""

from __future__ import annotations

import unittest

from computer_use import errors, keymap

LETTERS = {
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4,
    "i": 34, "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31,
    "p": 35, "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9,
    "w": 13, "x": 7, "y": 16, "z": 6,
}
DIGITS = {
    "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26,
    "8": 28, "9": 25, "0": 29,
}
NAMED = {
    "Return": 36, "Tab": 48, "Space": 49, "Delete": 51, "Escape": 53,
    "ForwardDelete": 117, "Home": 115, "End": 119, "PageUp": 116,
    "PageDown": 121,
}
ARROWS = {"Up": 126, "Down": 125, "Left": 123, "Right": 124}
FUNCTIONS = {
    "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97,
    "F7": 98, "F8": 100, "F9": 101, "F10": 109, "F11": 103, "F12": 111,
}


class KeycodesTableTests(unittest.TestCase):
    def test_letters(self) -> None:
        for name, value in LETTERS.items():
            with self.subTest(name=name):
                self.assertEqual(keymap.KEYCODES[name], value)

    def test_digits(self) -> None:
        for name, value in DIGITS.items():
            with self.subTest(name=name):
                self.assertEqual(keymap.KEYCODES[name], value)

    def test_named_keys(self) -> None:
        for name, value in NAMED.items():
            with self.subTest(name=name):
                self.assertEqual(keymap.KEYCODES[name], value)

    def test_arrows(self) -> None:
        for name, value in ARROWS.items():
            with self.subTest(name=name):
                self.assertEqual(keymap.KEYCODES[name], value)

    def test_function_keys(self) -> None:
        for name, value in FUNCTIONS.items():
            with self.subTest(name=name):
                self.assertEqual(keymap.KEYCODES[name], value)

    def test_backspace_aliases_delete(self) -> None:
        self.assertEqual(keymap.KEYCODES["Backspace"], keymap.KEYCODES["Delete"])
        self.assertEqual(keymap.KEYCODES["Delete"], 51)


    def test_ansi_punctuation(self) -> None:
        punctuation = {
            "=": 24, "-": 27, "]": 30, "[": 33, ";": 41, "\\": 42,
            ",": 43, "/": 44, ".": 47, "`": 50, "'": 39,
        }
        for name, value in punctuation.items():
            with self.subTest(name=name):
                self.assertEqual(keymap.KEYCODES[name], value)


class ParseChordTests(unittest.TestCase):
    def test_single_key(self) -> None:
        self.assertEqual(keymap._parse_chord("a"), keymap.ParsedChord(frozenset(), "a"))
        self.assertEqual(keymap._parse_chord("Return"), keymap.ParsedChord(frozenset(), "Return"))

    def test_enter_aliases_return(self) -> None:
        self.assertEqual(keymap._parse_chord("Enter"), keymap.ParsedChord(frozenset(), "Return"))
        self.assertEqual(keymap._parse_chord("Enter"), keymap._parse_chord("Return"))

    def test_backspace_aliases_delete_at_parse_level(self) -> None:
        self.assertEqual(keymap._parse_chord("Backspace"), keymap.ParsedChord(frozenset(), "Delete"))
        self.assertEqual(keymap._parse_chord("Backspace"), keymap._parse_chord("Delete"))

    def test_literal_space_is_space(self) -> None:
        self.assertEqual(keymap._parse_chord(" "), keymap.ParsedChord(frozenset(), " "))
        self.assertEqual(keymap.KEYCODES[" "], keymap.KEYCODES["Space"])
        self.assertEqual(keymap.KEYCODES[" "], 49)

    def test_single_char_punctuation(self) -> None:
        self.assertEqual(keymap._parse_chord("-"), keymap.ParsedChord(frozenset(), "-"))
        self.assertEqual(keymap._parse_chord("cmd+-"), keymap.ParsedChord(frozenset({"cmd"}), "-"))

    def test_modifier_canonicalization(self) -> None:
        pairs = (
            ("cmd+c", keymap.ParsedChord(frozenset({"cmd"}), "c")),
            ("command+c", keymap.ParsedChord(frozenset({"cmd"}), "c")),
            ("super+c", keymap.ParsedChord(frozenset({"cmd"}), "c")),
            ("CMD+c", keymap.ParsedChord(frozenset({"cmd"}), "c")),
            ("ctrl+a", keymap.ParsedChord(frozenset({"ctrl"}), "a")),
            ("control+a", keymap.ParsedChord(frozenset({"ctrl"}), "a")),
            ("alt+Tab", keymap.ParsedChord(frozenset({"alt"}), "Tab")),
            ("option+Tab", keymap.ParsedChord(frozenset({"alt"}), "Tab")),
            ("opt+Tab", keymap.ParsedChord(frozenset({"alt"}), "Tab")),
            ("shift+a", keymap.ParsedChord(frozenset({"shift"}), "a")),
        )
        for chord, expected in pairs:
            with self.subTest(chord=chord):
                self.assertEqual(keymap._parse_chord(chord), expected)

    def test_multiple_modifiers(self) -> None:
        self.assertEqual(
            keymap._parse_chord("cmd+shift+f"),
            keymap.ParsedChord(frozenset({"cmd", "shift"}), "f"),
        )

    def test_key_names_case_insensitive(self) -> None:
        self.assertEqual(keymap._parse_chord("RETURN"), keymap.ParsedChord(frozenset(), "Return"))
        self.assertEqual(keymap._parse_chord("A"), keymap.ParsedChord(frozenset(), "a"))
        self.assertEqual(keymap._parse_chord("f1"), keymap.ParsedChord(frozenset(), "F1"))


class ParseChordInvalidTests(unittest.TestCase):
    def assert_invalid(self, chord: object) -> None:
        with self.assertRaises(errors.ComputerUseError) as caught:
            keymap._parse_chord(chord)
        self.assertEqual(caught.exception.code, "INVALID_ARGUMENT")

    def test_empty_chord(self) -> None:
        self.assert_invalid("")

    def test_non_string_input(self) -> None:
        self.assert_invalid(42)

    def test_missing_key(self) -> None:
        self.assert_invalid("cmd")

    def test_empty_key_component(self) -> None:
        self.assert_invalid("cmd+")
        self.assert_invalid("cmd++c")
        self.assert_invalid("+c")

    def test_unknown_modifier(self) -> None:
        self.assert_invalid("notmod+c")

    def test_unknown_key(self) -> None:
        self.assert_invalid("notakey")
        self.assert_invalid("ctrl+notakey")


if __name__ == "__main__":
    unittest.main()
