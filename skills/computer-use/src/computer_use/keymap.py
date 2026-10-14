"""Key chord parsing and the macOS keycode table (pure Python, no pyobjc)."""

from __future__ import annotations

from dataclasses import dataclass

from .errors import ComputerUseError

_MODIFIERS = {
    "cmd": "cmd",
    "command": "cmd",
    "super": "cmd",
    "ctrl": "ctrl",
    "control": "ctrl",
    "alt": "alt",
    "option": "alt",
    "opt": "alt",
    "shift": "shift",
}

_NAMED_KEYS = {
    "return": "Return",
    "enter": "Return",
    "tab": "Tab",
    "escape": "Escape",
    "space": "Space",
    "delete": "Delete",
    "backspace": "Delete",
    "forwarddelete": "ForwardDelete",
    "home": "Home",
    "end": "End",
    "pageup": "PageUp",
    "pagedown": "PageDown",
    "up": "Up",
    "down": "Down",
    "left": "Left",
    "right": "Right",
}
for _index in range(1, 13):
    _NAMED_KEYS[f"f{_index}"] = f"F{_index}"

# Standard macOS VirtualKeycodes, keyed by canonical _parse_chord key names.
KEYCODES: dict[str, int] = {
    "Return": 36,
    "Enter": 36,
    "Tab": 48,
    "Space": 49,
    "Delete": 51,
    "Backspace": 51,
    "Escape": 53,
    "Home": 115,
    "PageUp": 116,
    "ForwardDelete": 117,
    "End": 119,
    "PageDown": 121,
    "Left": 123,
    "Right": 124,
    "Down": 125,
    "Up": 126,
    "a": 0,
    "s": 1,
    "d": 2,
    "f": 3,
    "h": 4,
    "g": 5,
    "z": 6,
    "x": 7,
    "c": 8,
    "v": 9,
    "b": 11,
    "q": 12,
    "w": 13,
    "e": 14,
    "r": 15,
    "y": 16,
    "t": 17,
    "o": 31,
    "u": 32,
    "i": 34,
    "p": 35,
    "l": 37,
    "j": 38,
    "k": 40,
    "n": 45,
    "m": 46,
    "1": 18,
    "2": 19,
    "3": 20,
    "4": 21,
    "6": 22,
    "5": 23,
    "9": 25,
    "7": 26,
    "8": 28,
    "0": 29,
    "=": 24,
    "-": 27,
    "]": 30,
    "[": 33,
    ";": 41,
    "\\": 42,
    ",": 43,
    "/": 44,
    ".": 47,
    "`": 50,
    "\'": 39,
    " ": 49,
    "F1": 122,
    "F2": 120,
    "F3": 99,
    "F4": 118,
    "F5": 96,
    "F6": 97,
    "F7": 98,
    "F8": 100,
    "F9": 101,
    "F10": 109,
    "F11": 103,
    "F12": 111,
}

_SUPPORTED_MODIFIERS = "cmd, command, super, ctrl, control, alt, option, opt, shift"
_SUPPORTED_KEYS = (
    "single characters, Return, Enter, Tab, Escape, Space, Delete, Backspace, "
    "ForwardDelete, Home, End, PageUp, PageDown, Up, Down, Left, Right, F1..F12"
)


@dataclass(frozen=True)
class ParsedChord:
    """A parsed key chord: canonical modifier names plus one canonical key name."""

    modifiers: frozenset[str]
    key: str


def _parse_chord(key: str) -> ParsedChord:
    """Parse a key chord such as "cmd+shift+f" or "Return" into its parts.

    Tokens are joined with "+" and no whitespace is stripped, so a lone " " means
    the Space key. The last token is the key; earlier tokens are modifiers.
    Modifier names are case-insensitive aliases (cmd/command/super, ctrl/control,
    alt/option/opt, shift) and key names are case-insensitive too. Enter is an
    alias of Return and Backspace is an alias of Delete.

    Raises ComputerUseError INVALID_ARGUMENT with a bounded message for a non-string,
    empty, or unsupported chord.
    """
    if not isinstance(key, str):
        raise ComputerUseError(
            "INVALID_ARGUMENT",
            f"key chord must be a string, got {type(key).__name__}",
            {"key": type(key).__name__},
        )
    if not key:
        raise ComputerUseError(
            "INVALID_ARGUMENT", "key chord is empty; expected a chord like cmd+shift+f", {"key": ""}
        )
    tokens = key.split("+")
    modifiers: set[str] = set()
    for token in tokens[:-1]:
        modifier = _MODIFIERS.get(token.lower())
        if modifier is None:
            raise ComputerUseError(
                "INVALID_ARGUMENT",
                f"unknown modifier {token[:24]!r}; supported modifiers: {_SUPPORTED_MODIFIERS}",
                {"key": key[:32]},
            )
        modifiers.add(modifier)
    return ParsedChord(frozenset(modifiers), _canonical_key(tokens[-1]))


def _canonical_key(token: str) -> str:
    named = _NAMED_KEYS.get(token.lower())
    if named is not None:
        return named
    if len(token) == 1:
        lowered = token.lower()
        if lowered in KEYCODES:
            return lowered
    raise ComputerUseError(
        "INVALID_ARGUMENT",
        f"unknown key {token[:24]!r}; supported keys: {_SUPPORTED_KEYS}",
        {"key": token[:32]},
    )
