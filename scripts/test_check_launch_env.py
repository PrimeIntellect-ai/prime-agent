#!/usr/bin/env python3
"""Reject stale result success and killing an unowned process in the verifier."""
import json
from pathlib import Path
import unittest
import tempfile
from unittest.mock import patch, MagicMock
from check_launch_env import current_probe, restart, verify_worker, worker_descriptor, finish_daemon, MARKER


def requests(content=None):
    messages = [{'role': 'tool', 'tool_call_id': 'launch_old', 'content': MARKER + '{"old":true}'}]
    if content is not None:
        messages.append({'role': 'tool', 'tool_call_id': 'launch_new', 'content': content})
    return [{}, {'messages': messages}]


class VerifierTests(unittest.TestCase):
    def test_only_current_result_counts(self):
        self.assertEqual(current_probe(requests(MARKER + '{"new":true}'), 'new'), {'new': True})

    def test_old_result_cannot_hide_failed_cell(self):
        with self.assertRaisesRegex(AssertionError, 'current probe'):
            current_probe(requests('Traceback: failed current cell'), 'new')

    def test_old_result_cannot_hide_missing_result(self):
        with self.assertRaisesRegex(AssertionError, 'current tool result'):
            current_probe(requests(), 'new')

    def test_duplicate_current_probe_is_failure(self):
        content = MARKER + '{}\n' + MARKER + '{}'
        with self.assertRaisesRegex(AssertionError, 'current probe'):
            current_probe(requests(content), 'new')

    def test_descriptor_with_wrong_identity_never_kills(self):
        with patch('check_launch_env.worker_descriptor', return_value=(Path('/fixture'),
                {'pid': 123, 'rootActiveSessionId': 'someone-else'})), patch('os.kill') as kill:
            with self.assertRaisesRegex(AssertionError, 'descriptor identity'):
                restart(None, 'fixture', Path('/fixture'), Path('/fixture/binary'), {}, False, {}, set(), {})
            kill.assert_not_called()

    def test_wrong_executable_never_kills(self):
        with patch('check_launch_env.worker_descriptor', return_value=(Path('/fixture'),
                {'pid': 123, 'rootActiveSessionId': 'fixture', 'supervisorSocketPath': '/d.sock'})), \
                patch('pathlib.Path.read_bytes', return_value=b'/other/binary\0worker\0'), patch('os.kill') as kill:
            with self.assertRaisesRegex(AssertionError, 'fixture binary'):
                restart(None, 'fixture', Path('/fixture'), Path('/fixture/binary'), {}, False, {}, set(), {})
            kill.assert_not_called()

    def test_descriptor_filename_need_not_equal_active_id(self):
        with tempfile.TemporaryDirectory() as folder:
            agent = Path(folder)
            descriptors = agent / 'daemon-workers' / 'fixture'
            descriptors.mkdir(parents=True)
            row = {'pid': 123, 'rootActiveSessionId': 'active-id', 'supervisorSocketPath': '/fixture.sock'}
            path = descriptors / 'different-worker-id.json'
            path.write_text(json.dumps(row))
            self.assertEqual(worker_descriptor(agent, 'active-id', Path('/fixture.sock')), (path, row))

    def test_both_worker_socket_seams_are_checked(self):
        row = {'pid': 123, 'rootActiveSessionId': 'fixture', 'supervisorSocketPath': '/fixture/d.sock',
               'socketPath': '/fixture/worker.sock', 'processStartId': 'proc:456'}
        env = b'PRIME_AGENT_INTERNAL_DAEMON_WORKER=1\0PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID=fixture\0PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET=/fixture/d.sock\0'
        for command, extra in [
            (b'/fixture/binary\0--mode\0daemon\0--daemon-socket\0/fixture/worker.sock\0', b''),
            (b'/fixture/binary\0worker\0', b'PRIME_AGENT_INTERNAL_DAEMON_WORKER_SOCKET=/fixture/worker.sock\0'),
        ]:
            with patch('pathlib.Path.read_bytes', side_effect=[command, env + extra]), \
                    patch('check_launch_env.process_identity', return_value=('proc:456', 'S')):
                self.assertEqual(verify_worker(row, 'fixture', Path('/fixture/binary'), Path('/fixture/d.sock')), (123, 'proc:456'))

    def test_reused_pid_is_rejected(self):
        row = {'pid': 123, 'rootActiveSessionId': 'fixture', 'supervisorSocketPath': '/fixture/d.sock',
               'socketPath': '/fixture/worker.sock', 'processStartId': 'proc:old'}
        command = b'/fixture/binary\0--mode\0daemon\0/fixture/worker.sock\0'
        env = b'PRIME_AGENT_INTERNAL_DAEMON_WORKER=1\0PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID=fixture\0PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET=/fixture/d.sock\0'
        with patch('pathlib.Path.read_bytes', side_effect=[command, env]), \
                patch('check_launch_env.process_identity', return_value=('proc:new', 'S')):
            with self.assertRaisesRegex(AssertionError, 'reused worker PID'):
                verify_worker(row, 'fixture', Path('/fixture/binary'), Path('/fixture/d.sock'))

    def test_shutdown_ack_then_close_then_process_exit(self):
        events = []
        client, process = MagicMock(), MagicMock(returncode=0)
        client.call.side_effect = lambda *a, **k: events.append('ack')
        client.close.side_effect = lambda: events.append('client_closed')
        process.wait.side_effect = lambda **k: events.append('process_exit')
        finish_daemon(client, process, 'shutdown', force=True)
        self.assertEqual(events, ['ack', 'client_closed', 'process_exit'])

    def test_refused_shutdown_cannot_be_cleanup_success(self):
        client, process = MagicMock(), MagicMock(returncode=0)
        client.call.side_effect = AssertionError('refused')
        with self.assertRaisesRegex(AssertionError, 'refused'):
            finish_daemon(client, process, 'shutdown', force=True)
        process.wait.assert_not_called()


if __name__ == '__main__':
    unittest.main()
