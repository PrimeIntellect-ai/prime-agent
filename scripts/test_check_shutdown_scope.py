#!/usr/bin/env python3
"""Guards on process identity and cleanup failure, with no actual processes."""
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import check_shutdown_scope as verifier


class OwnershipTests(unittest.TestCase):
    def test_pid_reuse_is_not_an_original_survivor(self):
        with patch.object(verifier, 'owned_identity', side_effect=lambda pid, root: {10: 'new-start', 20: 'same-start'}[pid]):
            self.assertEqual(verifier.survivors({10: 'old-start', 20: 'same-start'}, Path('/fixture')),
                             {20: 'same-start'})

    def test_an_unowned_process_has_no_identity(self):
        with patch.object(Path, 'read_bytes', return_value=b'PRIME_AGENT_CODING_AGENT_DIR=/another/agent\0'), patch.object(verifier, 'process_identity') as identity:
            self.assertIsNone(verifier.owned_identity(10, Path('/fixture')))
            identity.assert_not_called()

    def test_shutdown_ack_closes_client_before_waiting_for_supervisor(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'daemon.log').write_text('fixture')
            client = Mock(wire=[{'type': 'response', 'success': True}])
            process = Mock(poll=Mock(return_value=None))
            tree = {'root': root, 'process': process, 'client': client, 'log': io.BytesIO()}
            def waited(timeout):
                client.close.assert_called_once()
                self.assertIsNone(tree['client'])
            process.wait.side_effect = waited
            observed = {}
            with patch.object(verifier, 'stop'), patch.object(verifier, 'owned_processes', return_value={}):
                verifier.finish_tree(tree, observed)
            self.assertEqual(observed['wire'], [{'type': 'response', 'success': True}])
            self.assertEqual(observed['remaining_owned_processes'], {})

    def test_acknowledged_shutdown_never_reconnects_and_timeout_stays_red(self):
        for timeout in (False, True):
            with tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                (root / 'daemon.log').write_text('fixture')
                process = Mock(poll=Mock(return_value=None))
                if timeout:
                    process.wait.side_effect = TimeoutError('acknowledged process still alive')
                tree = {'root': root, 'process': process, 'client': None,
                        'shutdown_acknowledged': True, 'log': io.BytesIO()}
                observed = {}
                with patch.object(verifier, 'Client') as connect, patch.object(verifier, 'stop'), patch.object(verifier, 'owned_processes', return_value={}):
                    if timeout:
                        with self.assertRaisesRegex(RuntimeError, 'acknowledged process still alive'):
                            verifier.finish_tree(tree, observed)
                    else:
                        verifier.finish_tree(tree, observed)
                    connect.assert_not_called()
                    process.wait.assert_called_once()
                self.assertTrue(tree['shutdown_acknowledged'])
                self.assertTrue(observed['shutdown_already_acknowledged'])

    def test_cleanup_survival_fails_and_pid_reuse_is_not_signaled(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'daemon.log').write_text('fixture')
            tree = {'root': root, 'process': Mock(poll=Mock(return_value=0)), 'log': io.BytesIO()}
            observed = {}
            with patch.object(verifier, 'stop'), patch.object(verifier, 'owned_processes', return_value={10: 'old-start'}), patch.object(verifier, 'owned_identity', return_value='new-start'), patch.object(verifier.time, 'monotonic', side_effect=[0, verifier.LIMIT + 1]), patch.object(verifier.os, 'kill') as kill:
                with self.assertRaisesRegex(RuntimeError, 'detached fixture processes survived'):
                    verifier.finish_tree(tree, observed)
                kill.assert_not_called()
            self.assertEqual(observed['remaining_owned_processes'], {10: 'old-start'})
            self.assertTrue(tree['log'].closed)


if __name__ == '__main__':
    unittest.main()
