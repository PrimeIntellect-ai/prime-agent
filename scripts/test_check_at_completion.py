#!/usr/bin/env python3
"""Mock-only evidence guards. Never starts a product binary."""
import copy
import unittest
from unittest.mock import Mock, patch

from check_at_completion import CASES, children_visible, close_terminal, completion_rows, discover_direct, frame, verify
from lifecycle_lib import DockScreen


def observations():
    case = {'behavior_verified': True, 'cleanup_verified': True, 'inputs': ['40646972', '09'],
            'frames': {'after': {'text': 'only_child.rs', 'menu_rows': ['only_child.rs'],
                                 'children_visible': True}}}
    return {name: copy.deepcopy(case) for name in CASES}


class EvidenceGuards(unittest.TestCase):
    def discovery(self, tag, argv, ownership=True):
        files = {'environ': Mock(), 'cmdline': Mock()}
        files['environ'].read_bytes.return_value = b'PA_GOAL_FIXTURE_ID=' + tag + b'\0'
        files['cmdline'].read_bytes.return_value = argv

        class Entry:
            name = '42'

            def __truediv__(self, key):
                return files[key]

        scope = Mock(root='/case', direct={}, targets={})
        scope.ownership.return_value = ownership
        with patch('check_at_completion.Path') as proc, \
                patch('check_at_completion.process_identity', return_value=('proc:10', 'S')):
            proc.return_value.iterdir.return_value = [Entry()]
            discover_direct(scope, ['/binary', '--daemon-socket', '/case/fixture.sock'])
        return scope

    def test_constructor_recovery_requires_exact_tag_and_argv(self):
        argv = b'/binary\0--daemon-socket\0/case/fixture.sock\0'
        self.assertEqual(self.discovery(b'/case', argv).targets, {42: 'proc:10'})
        self.assertEqual(self.discovery(b'/other-case', argv).targets, {})
        self.assertEqual(self.discovery(b'/case', b'/other-binary\0').targets, {})

    def test_reused_identity_is_rejected_after_constructor_recovery(self):
        argv = b'/binary\0--daemon-socket\0/case/fixture.sock\0'
        scope = self.discovery(b'/case', argv, ownership=False)
        self.assertEqual((scope.targets, scope.direct), ({}, {}))

    def test_editor_token_does_not_count_as_a_child_menu(self):
        text = '│ @"dir with spaces/only_child.rs"\nmodel · 0 tokens'
        self.assertFalse(children_visible(text))
        self.assertEqual(completion_rows(text), [])

    def test_actual_menu_row_counts_beside_quoted_editor(self):
        self.assertTrue(children_visible('› only_child.rs   dir with spaces/only_child.rs\n'
                                         '│ @"dir with spaces/"'))

    def test_directory_row_alone_is_not_a_child(self):
        self.assertFalse(children_visible('› dir with spaces/   dir with spaces\n│ @dir'))

    def test_missing_children_fails_even_when_other_phases_pass(self):
        cases = observations()
        cases['enter']['frames']['after']['children_visible'] = False
        with self.assertRaises(AssertionError):
            verify(cases)

    def test_unexecuted_case_cannot_pass(self):
        cases = observations()
        cases['tab']['behavior_verified'] = False
        with self.assertRaises(AssertionError):
            verify(cases)

    def test_failed_cleanup_cannot_pass(self):
        cases = observations()
        cases['typed_slash']['cleanup_verified'] = False
        with self.assertRaises(AssertionError):
            verify(cases)

    def test_caught_case_error_cannot_pass(self):
        cases = observations()
        cases['enter']['error'] = 'capture failed'
        with self.assertRaises(AssertionError):
            verify(cases)

    def test_unknown_terminal_geometry_cannot_pass_frame_evidence(self):
        screen = DockScreen()
        screen.feed(b'\x1b[3S')
        with self.assertRaises(AssertionError):
            frame(Mock(screen=screen, raw=bytearray()))

    def test_cleanup_fallback_remains_red_and_joins_peer(self):
        terminal = Mock(raw=bytearray(), master=7)
        terminal.process.poll.return_value = None
        scope = Mock(targets={})
        scope.live.return_value = []
        server = Mock(commands=[], errors=[])
        observed = {}
        with patch('check_at_completion.discover_direct'), \
                patch('check_at_completion.time.monotonic', side_effect=[0, 20]), \
                patch('check_at_completion.os.close'):
            with self.assertRaisesRegex(AssertionError, 'ordinary TUI exit'):
                close_terminal(terminal, scope, server, observed)
        self.assertFalse(observed['cleanup_verified'])
        server.close.assert_called_once()

    def test_peer_still_joins_when_pty_close_fails(self):
        terminal = Mock(raw=bytearray(), master=7)
        terminal.process.poll.return_value = 0
        scope = Mock(targets={})
        server = Mock(commands=[], errors=[])
        observed = {}
        with patch('check_at_completion.discover_direct'), \
                patch('check_at_completion.os.close', side_effect=OSError('close failed')):
            with self.assertRaisesRegex(AssertionError, 'PTY close'):
                close_terminal(terminal, scope, server, observed)
        self.assertFalse(observed['cleanup_verified'])
        server.close.assert_called_once()

    def test_constructor_failure_still_discovers_and_rejects_live_owned_processes(self):
        scope = Mock(targets={})
        scope.live.return_value = []
        scope.wait_gone.side_effect = AssertionError('owned child survived')
        server = Mock(commands=[], errors=[])
        observed = {}
        with patch('check_at_completion.discover_direct') as discover:
            with self.assertRaisesRegex(AssertionError, 'owned child survived'):
                close_terminal(None, scope, server, observed)
        discover.assert_called_once()
        self.assertFalse(observed['cleanup_verified'])
        server.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()
