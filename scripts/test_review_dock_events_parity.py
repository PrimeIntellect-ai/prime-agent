#!/usr/bin/env python3
import unittest

from review_dock_events_parity import running_visible
from review_dock_screen import DockScreen


class CaptureTests(unittest.TestCase):
    def test_style_only_focus_change_is_observable(self):
        screen = DockScreen(width=20, height=3)
        screen.feed(b'1 subagents')
        before = screen.dock_styles()
        screen.feed(b'\r\x1b[48;2;1;2;3m1 subagents\x1b[0m')
        self.assertEqual(before[0]['text'], screen.dock_styles()[0]['text'])
        self.assertNotEqual(before, screen.dock_styles())
        self.assertEqual(screen.styles[0][0]['bg'], [2, 1, 2, 3])

    def test_erase_and_reset_remove_stale_style(self):
        screen = DockScreen(width=20, height=3)
        screen.feed(b'\x1b[7m1 subagents\x1b[0m\r\x1b[2K')
        self.assertEqual(screen.styles[0], [{}] * 20)
        self.assertEqual(screen.text().strip(), '')

    def test_partial_ansi_does_not_repaint_until_complete(self):
        screen = DockScreen(width=20, height=3)
        screen.feed(b'\x1b[48;2;1;')
        self.assertEqual(screen.text().strip(), '')
        screen.feed(b'2;3m1 subagents')
        self.assertEqual(screen.styles[0][0]['bg'], [2, 1, 2, 3])

    def test_count_predicate_distinguishes_events_and_layouts(self):
        self.assertTrue(running_visible('1 running', 'ts', 1))
        self.assertFalse(running_visible('1 running', 'ts', 2))
        self.assertTrue(running_visible('2 subagents', 'rust', 2))


if __name__ == '__main__':
    unittest.main()
