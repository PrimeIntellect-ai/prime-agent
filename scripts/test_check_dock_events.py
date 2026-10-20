#!/usr/bin/env python3
import unittest
from pathlib import Path
import tempfile
import json
import threading
from unittest.mock import Mock, patch

from check_dock_events import DockSupervisor, child, cost_ready, parent, run_case, running_visible, visible_cost
from lifecycle_lib import DockScreen


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
        self.assertTrue(running_visible('2 subagents', 2))
        self.assertFalse(running_visible('2 subagents', 1))
        self.assertTrue(running_visible('◆ 1 subagent   ·', 1))
        expanded = '◆ subagents   2 running · 0 idle · 0 inactive'
        self.assertTrue(running_visible(expanded, 2, expanded=True))
        self.assertFalse(running_visible(expanded, 2))
        self.assertFalse(running_visible('◆ 2 subagents', 2, expanded=True))

    def test_count_has_integer_boundaries(self):
        self.assertFalse(running_visible('10 subagents', 0))
        self.assertFalse(running_visible('12 subagents', 2))
        self.assertTrue(running_visible('● 0 subagents  ·', 0))

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
                patch('check_dock_events.actual_hello', return_value={}), \
                patch('check_dock_events.DockSupervisor', return_value=server), \
                patch('check_dock_events.Terminal', return_value=terminal):
            observed = {}
            with self.assertRaisesRegex(RuntimeError, 'terminal cleanup failed'):
                run_case(Path('/fixture-binary'), Path(folder) / 'case', observed)
        server.close.assert_called_once()
        self.assertNotIn('cleanup_verified', observed)

    def test_actual_keyboard_controls_do_not_corrupt_sgr(self):
        screen = DockScreen()
        screen.feed(b'\x1b[31;1m')
        before = dict(screen.sgr)
        replies = screen.feed(b'\x1b[>4;0m\x1b[?u\x1b[>1u\x1b[<u1 subagents')
        self.assertEqual(screen.sgr, before)
        self.assertEqual(screen.styles[0][0], before)
        self.assertNotIn('4', screen.styles[0][0])
        self.assertEqual(replies, [])
        self.assertEqual(screen.keyboard_controls,
                         ['\x1b[>4;0m', '\x1b[?u', '\x1b[>1u', '\x1b[<u'])
        self.assertEqual(screen.unsupported_terminal, [])

    def test_partial_keyboard_query_never_advertises_kitty_support(self):
        screen = DockScreen()
        self.assertEqual(screen.feed(b'\x1b[?'), [])
        self.assertEqual(screen.keyboard_controls, [])
        self.assertEqual(screen.feed(b'u'), [])
        self.assertEqual(screen.feed(b'\x1b[>9;0m'), [])
        self.assertEqual(screen.unsupported_terminal, ['\x1b[>9;0m'])

    def test_full_crossterm_probe_gets_only_non_kitty_da1_reply(self):
        screen = DockScreen()
        screen.feed(b'\x1b[31m1 subagents')
        before = screen.dock_styles()
        cursor = (screen.row, screen.col)
        replies = screen.feed(b'\x1b[?u\x1b[c')
        self.assertEqual(replies, [b'\x1b[?1;2c'])
        self.assertFalse(any(reply.endswith(b'u') for reply in replies))
        self.assertEqual(screen.dock_styles(), before)
        self.assertEqual((screen.row, screen.col), cursor)
        self.assertEqual(screen.unsupported_terminal, [])

    def test_dock_hello_advertises_implemented_roster_capability(self):
        server = DockSupervisor.__new__(DockSupervisor)
        server.write_lock = threading.Lock()
        sock = Mock()
        server.send(sock, {'type': 'daemon_hello', 'serverCapabilities': ['session_input_admission']})
        wire = json.loads(sock.sendall.call_args.args[0])
        self.assertEqual(wire['serverCapabilities'], ['session_input_admission', 'agent_roster'])

    def test_context_tree_and_roster_describe_same_family_usage(self):
        server = DockSupervisor.__new__(DockSupervisor)
        server.write_lock = threading.Lock()
        server.roster = [parent(), child('c1', 'running', 0.42), child('c2', 'running', 0.49)]
        server.context_responses = []
        sock = Mock()
        server.send(sock, {'type': 'response', 'command': 'get_context_tree', 'success': True, 'data': {}})
        tree = json.loads(sock.sendall.call_args.args[0])['data']
        self.assertAlmostEqual(tree['totalUsage']['cost']['total'], 0.91)
        self.assertEqual([node['ownUsage']['cost']['total'] for node in tree['children']], [0.42, 0.49])
        self.assertEqual(len(server.context_responses), 1)

    def test_cost_probe_rejects_ambiguity(self):
        self.assertEqual(visible_cost('Dock fixture $0.42'), '0.42')
        with self.assertRaises(AssertionError):
            visible_cost('no cost')
        with self.assertRaises(AssertionError):
            visible_cost('$0.42 and $0.91')
        self.assertFalse(cost_ready('partial repaint $0.', '0.42'))
        self.assertTrue(cost_ready('Dock fixture $0.42', '0.42'))

    def test_exact_default_color_queries_do_not_mutate_capture(self):
        screen = DockScreen()
        screen.feed(b'\x1b[31m1 subagents')
        before = screen.dock_styles()
        self.assertEqual(screen.feed(b'\x1b]10;?\x1b\\\x1b]11;?\x07'), [])
        self.assertEqual(screen.dock_styles(), before)
        self.assertEqual(screen.unsupported_terminal, [])
        screen.feed(b'\x1b]10;#abcdef\x1b\\')
        self.assertEqual(screen.unsupported_terminal, ['\x1b]10;#abcdef\x1b\\'])


if __name__ == '__main__':
    unittest.main()
