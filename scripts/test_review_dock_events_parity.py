#!/usr/bin/env python3
import unittest
from pathlib import Path
import tempfile
from unittest.mock import Mock, patch

from review_dock_events_parity import run_case, running_visible
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

    def test_count_has_integer_boundaries(self):
        for kind, label in [('ts', 'running'), ('rust', 'subagents')]:
            self.assertFalse(running_visible('10 ' + label, kind, 0))
            self.assertFalse(running_visible('12 ' + label, kind, 2))
            self.assertTrue(running_visible('● 0 ' + label + '  ·', kind, 0))

    def test_unknown_geometry_is_recorded(self):
        screen = DockScreen()
        screen.feed(b'\x1b[3S\x1b[1;5r\x1b[L\x1bM\x1b[1J')
        self.assertEqual(screen.unsupported_terminal,
                         ['\x1b[3S', '\x1b[1;5r', '\x1b[L', '\x1bM', '\x1b[1J'])

    def test_harmless_modes_title_and_cursor_style_are_allowed(self):
        screen = DockScreen()
        screen.feed(b'\x1b[?25l\x1b[?1006h\x1b[?2004h\x1b[2 q\x1b]2;fixture title\x07')
        self.assertEqual(screen.unsupported_terminal, [])

    def test_alternate_buffer_restores_cells_and_styles(self):
        screen = DockScreen(width=20, height=3)
        screen.feed(b'\x1b[31m1 subagents\x1b[?1049h')
        self.assertEqual(screen.text().strip(), '')
        screen.feed(b'\x1b[32m2 subagents\x1b[?1049l')
        self.assertEqual(screen.text().strip(), '1 subagents')
        self.assertEqual(screen.styles[0][0]['fg'], ['ansi', 31])
        self.assertEqual(screen.sgr['fg'], ['ansi', 31])

    def test_partial_charset_and_palette_change_are_not_silently_ignored(self):
        screen = DockScreen()
        screen.feed(b'\x1b(')
        self.assertEqual(screen.unsupported_terminal, [])
        screen.feed(b'B\x1b]4;1;rgb:00/00/00\x07')
        self.assertEqual(screen.unsupported_terminal, ['\x1b]4;1;rgb:00/00/00\x07'])

    def test_server_closes_when_terminal_cleanup_raises(self):
        server = Mock(path=Path('/fixture.sock'), emitted=[], commands=[], errors=[])
        terminal = Mock(raw=bytearray())
        terminal.wait.side_effect = RuntimeError('initial readiness failed')
        terminal.close.side_effect = RuntimeError('terminal cleanup failed')
        with tempfile.TemporaryDirectory() as folder, \
                patch('review_dock_events_parity.actual_hello', return_value={}), \
                patch('review_dock_events_parity.DockSupervisor', return_value=server), \
                patch('review_dock_events_parity.Terminal', return_value=terminal):
            observed = {}
            with self.assertRaisesRegex(RuntimeError, 'terminal cleanup failed'):
                run_case(Path('/fixture-binary'), 'rust', Path(folder) / 'case', observed)
        server.close.assert_called_once()
        self.assertNotIn('cleanup_verified', observed)


if __name__ == '__main__':
    unittest.main()
