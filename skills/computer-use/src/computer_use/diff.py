"""State serialization and element-indexed diffs for computer use.

serialize renders a nested element tree into stable one-line-per-element
lines; diff pairs two renders and marks changed lines with "~", added lines
with "+", and removed lines with "-", omitting unchanged lines. Lines pair by
their content with the element index stripped, so an element that shifts
positions without changing still reads as unchanged, while a value change on
the same element reads as one "~" line. Output lines always carry the indices
of the full current snapshot (removed lines keep their previous index); the
diff is display-only.
"""

from __future__ import annotations

import re
from difflib import SequenceMatcher
from typing import Any

from .ax import _is_secure_field

_INDEXED = re.compile(r"^(\s*)\[\d+\] ")


def _serialize(tree: list[dict[str, Any]]) -> list[str]:
    """Render one element tree depth-first into stable indexed lines.

    Line shape: "{indent}[{index}] role (subrole) 'title' = 'value'
    description='...' placeholder='...' [secure] (actions: a, b)
    @ (x, y) WxH" with every empty attribute omitted. Secure fields never
    render their value and carry the [secure] marker instead.
    """
    lines: list[str] = []
    index = 0
    stack: list[tuple[dict[str, Any], int]] = [(element, 0) for element in reversed(tree)]
    while stack:
        element, depth = stack.pop()
        lines.append(_line(index, depth, element))
        index += 1
        for child in reversed(element.get("children") or []):
            stack.append((child, depth + 1))
    return lines


def _diff(previous_lines: list[str], current_lines: list[str]) -> str:
    """Mark the changes between two renders, omitting unchanged lines.

    Lines pair by index-stripped content: a 1:1 replaced line renders as "~"
    plus the current line, any other replacement renders as "-" per previous
    line and "+" per current line, and equal lines drop out — except when an
    insertion or deletion shifted the element's index: those render as "~"
    plus the current line so a caller reusing the old index sees the shift
    instead of silently targeting a different element.
    """
    previous_content = [_strip_index(line) for line in previous_lines]
    current_content = [_strip_index(line) for line in current_lines]
    matcher = SequenceMatcher(a=previous_content, b=current_content, autojunk=False)
    output: list[str] = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for previous_line, current_line in zip(previous_lines[i1:i2], current_lines[j1:j2]):
                if _index_of(previous_line) != _index_of(current_line):
                    output.append("~" + current_line)
            continue
        if tag == "replace":
            if i2 - i1 == j2 - j1:
                output.extend("~" + line for line in current_lines[j1:j2])
            else:
                output.extend("-" + line for line in previous_lines[i1:i2])
                output.extend("+" + line for line in current_lines[j1:j2])
        elif tag == "delete":
            output.extend("-" + line for line in previous_lines[i1:i2])
        elif tag == "insert":
            output.extend("+" + line for line in current_lines[j1:j2])
    return "\n".join(output)


def _index_of(line: str) -> str | None:
    """Return one rendered line's element index, or None when it has none."""
    matched = re.match(r"^\s*\[(\d+)\] ", line)
    return matched.group(1) if matched else None


def _strip_index(line: str) -> str:
    """Drop the leading element index so shifted elements with equal content pair up."""
    return _INDEXED.sub(r"\1", line, count=1)


def _line(index: int, depth: int, element: dict[str, Any]) -> str:
    """Render one element as an indexed, indented line."""
    parts = [f"{'  ' * depth}[{index}] {element.get('role') or 'AXUnknown'}"]
    subrole = element.get("subrole")
    if subrole:
        parts.append(f"({subrole})")
    title = element.get("title")
    if title:
        parts.append(repr(str(title)))
    if _is_secure_field(element):
        parts.append("[secure]")
    else:
        value = element.get("value")
        if value is not None and value != "":
            parts.append(f"= {value!r}")
    description = element.get("description")
    if description:
        parts.append(f"description={str(description)!r}")
    placeholder = element.get("placeholder")
    if placeholder:
        parts.append(f"placeholder={str(placeholder)!r}")
    actions = element.get("actions") or []
    if actions:
        parts.append(f"(actions: {', '.join(str(action) for action in actions)})")
    geometry = _geometry(element)
    if geometry:
        parts.append(geometry)
    return " ".join(parts)


def _geometry(element: dict[str, Any]) -> str:
    """Render one element's position and size, or an empty string when absent."""
    position = element.get("position")
    size = element.get("size")
    if not position:
        return ""
    rendered = f"@ ({_number(position[0])}, {_number(position[1])})"
    if size:
        rendered += f" {_number(size[0])}x{_number(size[1])}"
    return rendered


def _number(value: Any) -> str:
    """Format one coordinate compactly and deterministically."""
    number = float(value)
    if number.is_integer():
        return str(int(number))
    return f"{round(number, 1)}"
