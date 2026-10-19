"""Mocked ownership/cleanup guards; no product binaries or kernels are started."""
import json
from pathlib import Path
import signal
import tempfile
import unittest
from unittest.mock import Mock, patch

import review_goal_backoff_parity as goal
import review_goal_fixture_lifecycle as lifecycle


class CleanupTests(unittest.TestCase):
    def test_ack_then_close_then_exit_then_owned_absence(self):
        order = []
        scope, client, daemon = Mock(), Mock(), Mock(returncode=0)
        client.call.side_effect = lambda *_args, **_kwargs: order.append('ack')
        client.close.side_effect = lambda: order.append('close')
        daemon.wait.side_effect = lambda **_kwargs: order.append('exit')
        scope.wait_gone.side_effect = lambda *_args: order.append('absent')
        scope.targets = {}
        observation = {}
        lifecycle.finish(scope, client, daemon, observation)
        self.assertEqual(order[:4], ['ack', 'close', 'exit', 'absent'])
        self.assertTrue(observation['cleanup_verified'])
        scope.send.assert_not_called()

    def test_successful_fallback_keeps_shutdown_failure_red(self):
        scope, client, daemon = Mock(), Mock(), Mock()
        client.call.side_effect = TimeoutError('shutdown ack missing')
        scope.live.side_effect = [[12], []]
        scope.send.return_value = True
        scope.targets, scope.errors = {12: 'proc:4'}, []
        observation = {}
        lifecycle.finish(scope, client, daemon, observation)
        self.assertFalse(observation['cleanup_verified'])
        self.assertEqual(observation['cleanup_error'], 'shutdown ack missing')
        self.assertEqual(observation['fallback_signals'], [{'pid': 12, 'signal': 'SIGTERM'}])
        self.assertEqual(observation['fallback_remaining'], [])

    def test_reused_pid_is_never_signaled(self):
        scope = lifecycle.OwnedProcesses(Path('/fixture/bin'), Path('/fixture'), Path('/fixture/d.sock'))
        scope.targets[12] = 'proc:4'
        with patch.object(lifecycle.os, 'pidfd_open', return_value=9, create=True), \
                patch.object(lifecycle.os, 'close') as close, \
                patch.object(lifecycle.signal, 'pidfd_send_signal', create=True) as send, \
                patch.object(scope, 'ownership', return_value=False):
            self.assertFalse(scope.send(12, signal.SIGKILL))
            send.assert_not_called()
            close.assert_called_once_with(9)

    def test_pidfd_pins_signal_after_validation(self):
        scope = lifecycle.OwnedProcesses(Path('/fixture/bin'), Path('/fixture'), Path('/fixture/d.sock'))
        scope.targets[12] = 'proc:4'
        with patch.object(lifecycle.os, 'pidfd_open', return_value=9, create=True), \
                patch.object(lifecycle.os, 'close'), \
                patch.object(lifecycle.signal, 'pidfd_send_signal', create=True) as send, \
                patch.object(scope, 'ownership', return_value=True) as ownership:
            self.assertTrue(scope.send(12, signal.SIGTERM))
            ownership.assert_called_once_with(12, 'proc:4')
            send.assert_called_once_with(9, signal.SIGTERM)

    def test_foreign_fixture_tag_never_owned(self):
        scope = lifecycle.OwnedProcesses(Path('/fixture/bin'), Path('/fixture'), Path('/fixture/d.sock'))
        scope.direct[12] = ('proc:4', [b'/fixture/bin'])
        with patch.object(lifecycle, 'process_identity', return_value=('proc:4', 'S')), \
                patch.object(Path, 'read_bytes', return_value=b'PA_GOAL_FIXTURE_ID=/foreign\0'):
            self.assertFalse(scope.ownership(12, 'proc:4'))

    def test_same_tag_different_direct_argv_never_owned(self):
        scope = lifecycle.OwnedProcesses(Path('/fixture/bin'), Path('/fixture'), Path('/fixture/d.sock'))
        scope.direct[12] = ('proc:4', [b'/fixture/bin', b'--mode', b'daemon'])
        with patch.object(lifecycle, 'process_identity', return_value=('proc:4', 'S')), \
                patch.object(Path, 'read_bytes', side_effect=[b'PA_GOAL_FIXTURE_ID=/fixture\0', b'/fixture/bin\0different\0']):
            self.assertFalse(scope.ownership(12, 'proc:4'))

    def test_kernel_requires_verified_owner(self):
        scope = lifecycle.OwnedProcesses(Path('/fixture/bin'), Path('/fixture'), Path('/fixture/d.sock'))
        scope.targets = {12: 'proc:4'}
        for owner, expected in ((12, True), (99, False)):
            with patch.object(lifecycle, 'process_identity', return_value=('proc:8', 'S')), \
                    patch.object(Path, 'read_bytes', side_effect=[
                        ('PA_GOAL_FIXTURE_ID=/fixture\0PRIME_AGENT_KERNEL_OWNER_PID=%s\0' % owner).encode(), b'/usr/bin/python3\0kernel\0']):
                self.assertEqual(scope.ownership(20, 'proc:8'), expected)

    def test_receipt_survives_directory_cleanup_failure_and_primary_error(self):
        with tempfile.TemporaryDirectory() as temp:
            receipt = Path(temp) / 'receipt.json'
            fake_dir = Mock(name='temporary directory')
            fake_dir.name = temp
            fake_dir.cleanup.side_effect = OSError('Directory not empty')
            def run(_binary, _label, _scenario, _base_dir, observation):
                observation['primary_error'] = 'original probe failure'
                raise AssertionError('original probe failure')
            with patch.object(goal.sys, 'argv', ['fixture', '--receipt', str(receipt)]), \
                    patch.object(goal.sys, 'platform', 'linux'), \
                    patch.dict(goal.os.environ, {'PA_TS_BINARY': '/fake/ts', 'PA_RUST_BINARY': '/fake/rust', 'PA_TS_ARCHIVE': '/fake/archive'}), \
                    patch.object(Path, 'is_file', return_value=True), \
                    patch.object(goal.os, 'access', return_value=True), \
                    patch.object(goal, 'sha256', return_value=goal.TS_ARCHIVE_SHA256), \
                    patch.object(goal.tempfile, 'TemporaryDirectory', return_value=fake_dir), \
                    patch.object(goal, 'run_case', side_effect=run):
                self.assertEqual(goal.main(), 1)
            result = json.loads(receipt.read_text())
            self.assertIn('original probe failure', result['fixture_error'])
            self.assertEqual(result['directory_cleanup_error'], 'Directory not empty')
            self.assertFalse(result['validation_complete'])
            self.assertFalse(result['parity'])
            fake_dir.cleanup.assert_called_once()


if __name__ == '__main__':
    unittest.main()
