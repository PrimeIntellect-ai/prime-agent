"""Tests for computer_use.diff: serialization stability and the diff engine.

serialize renders a nested element tree into element-indexed lines; diff pairs
two serialized snapshots by the embedded element index: "~" marks a changed
line, "+" an added line, "-" a removed line, and unchanged lines are omitted.
"""

from __future__ import annotations

import re
import unittest

import fakes
from computer_use import diff


def lines(tree: dict | list) -> list[str]:
    """Serialize one canned tree (dict root or element list) into lines."""
    elements = tree["children"] if isinstance(tree, dict) else tree
    return diff._serialize(elements)


def marked_lines(marked: str, marker: str) -> list[str]:
    """Return the diff output lines carrying one marker."""
    return [line for line in marked.splitlines() if line.startswith(marker)]


class SerializationTests(unittest.TestCase):
    def test_serialization_is_stable(self) -> None:
        self.assertEqual(lines(fakes.small_tree()), lines(fakes.deep_copy(fakes.small_tree())))

    def test_serialization_covers_contract_fields(self) -> None:
        text = "\n".join(lines(fakes.small_tree()))
        for part in ("Search", "Save", "Enabled", "Password", "AXTextField", "AXButton", "AXStaticText"):
            with self.subTest(part=part):
                self.assertIn(part, text)

    def test_indices_are_assigned_per_snapshot(self) -> None:
        rendered = lines(fakes.small_tree())
        indices = []
        for line in rendered:
            match = re.match(r"\s*\[(\d+)\]", line)
            self.assertIsNotNone(match)
            indices.append(int(match.group(1)))
        self.assertEqual(indices, list(range(len(rendered))))

    def test_nested_elements_are_indented_by_depth(self) -> None:
        rendered = lines(fakes.large_tree())
        depths = [len(line) - len(line.lstrip(" ")) for line in rendered]
        self.assertIn(4, depths)

    def test_secure_field_omits_value_and_is_marked(self) -> None:
        text = "\n".join(lines(fakes.small_tree()))
        password_lines = [line for line in text.splitlines() if "Password" in line]
        self.assertEqual(len(password_lines), 1)
        self.assertIn("[secure]", password_lines[0])
        self.assertNotIn("hunter2", text)

    def test_button_line_shape(self) -> None:
        text = "\n".join(lines(fakes.small_tree()))
        save_lines = [line for line in text.splitlines() if "Save" in line]
        self.assertEqual(len(save_lines), 1)
        self.assertIn("AXButton", save_lines[0])
        self.assertIn("'Save'", save_lines[0])
        self.assertIn("(actions: AXPress)", save_lines[0])
        self.assertIn("@", save_lines[0])

    def test_empty_tree_renders_no_lines(self) -> None:
        self.assertEqual(diff._serialize([]), [])


class DiffMarkerTests(unittest.TestCase):
    def test_identical_snapshots_produce_empty_diff(self) -> None:
        before = lines(fakes.small_tree())
        after = lines(fakes.deep_copy(fakes.small_tree()))
        self.assertEqual(diff._diff(before, after), "")

    def test_changed_value_is_marked_with_tilde(self) -> None:
        before = lines(fakes.small_tree())
        after = lines(fakes.with_changed_value(fakes.small_tree(), "Search", "new query"))
        marked = diff._diff(before, after)
        tilde_lines = marked_lines(marked, "~")
        self.assertEqual(len(tilde_lines), 1)
        self.assertIn("new query", tilde_lines[0])
        self.assertNotIn("'query'", tilde_lines[0])

    def test_added_element_is_marked_with_plus(self) -> None:
        before = lines(fakes.small_tree())
        after = lines(
            fakes.with_added_child(
                fakes.small_tree(),
                "Enabled",
                fakes.element(role="AXButton", title="Fresh"),
            )
        )
        marked = diff._diff(before, after)
        plus_lines = marked_lines(marked, "+")
        self.assertEqual(len(plus_lines), 1)
        self.assertIn("Fresh", plus_lines[0])

    def test_removed_element_is_marked_with_minus(self) -> None:
        before = lines(fakes.small_tree())
        after = lines(fakes.without_child(fakes.small_tree(), "Password"))
        marked = diff._diff(before, after)
        minus_lines = marked_lines(marked, "-")
        self.assertEqual(len(minus_lines), 1)
        self.assertIn("Password", minus_lines[0])
        self.assertNotIn("Save", marked)

    def test_unchanged_lines_are_omitted(self) -> None:
        before = lines(fakes.small_tree())
        after = lines(fakes.with_changed_value(fakes.small_tree(), "Search", "new query"))
        marked = diff._diff(before, after)
        for title in ("Save", "Enabled", "Password"):
            with self.subTest(title=title):
                self.assertNotIn(title, marked)


class DiffEdgeCaseTests(unittest.TestCase):
    def test_empty_before_snapshot_shows_everything_as_added(self) -> None:
        current = lines(fakes.small_tree())
        marked = diff._diff([], current)
        self.assertEqual(len(marked_lines(marked, "+")), len(current))
        self.assertIn("Search", marked)

    def test_empty_after_snapshot_shows_everything_as_removed(self) -> None:
        before = lines(fakes.small_tree())
        marked = diff._diff(before, [])
        self.assertEqual(len(marked_lines(marked, "-")), len(before))

    def test_large_tree_single_change_diffs_to_one_line(self) -> None:
        before = lines(fakes.large_tree())
        after = lines(fakes.with_changed_value(fakes.large_tree(), "Text 3-4-2", "renamed"))
        marked = diff._diff(before, after)
        changed = [line for line in marked.splitlines() if line[:1] in ("~", "+", "-")]
        self.assertEqual(len(changed), 1)

    def test_large_tree_serialization_is_deterministic(self) -> None:
        self.assertEqual(lines(fakes.large_tree()), lines(fakes.deep_copy(fakes.large_tree())))


if __name__ == "__main__":
    unittest.main()
