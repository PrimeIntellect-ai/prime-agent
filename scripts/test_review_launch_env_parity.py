#!/usr/bin/env python3
"""Reject stale result success and killing an unowned process in the verifier."""
import json
from pathlib import Path
import unittest
import tempfile
from unittest.mock import patch, MagicMock
from review_launch_env_parity import current_probe, restart, verify_worker, worker_descriptor, finish_daemon, comparable_probes, MARKER


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
        with patch('review_launch_env_parity.worker_descriptor', return_value=(Path('/fixture'),
                {'pid': 123, 'rootActiveSessionId': 'someone-else'})), patch('os.kill') as kill:
            with self.assertRaisesRegex(AssertionError, 'descriptor identity'):
                restart(None, 'fixture', Path('/fixture'), Path('/fixture/binary'), {}, False, {}, set(), 'rust', {})
            kill.assert_not_called()

    def test_wrong_executable_never_kills(self):
        with patch('review_launch_env_parity.worker_descriptor', return_value=(Path('/fixture'),
                {'pid': 123, 'rootActiveSessionId': 'fixture', 'supervisorSocketPath': '/d.sock'})), \
                patch('pathlib.Path.read_bytes', return_value=b'/other/binary\0worker\0'), patch('os.kill') as kill:
            with self.assertRaisesRegex(AssertionError, 'fixture binary'):
                restart(None, 'fixture', Path('/fixture'), Path('/fixture/binary'), {}, False, {}, set(), 'rust', {})
            kill.assert_not_called()

    def test_ts_descriptor_filename_need_not_equal_active_id(self):
        with tempfile.TemporaryDirectory() as folder:
            agent = Path(folder)
            descriptors = agent / 'daemon-workers' / 'fixture'
            descriptors.mkdir(parents=True)
            row = {'pid': 123, 'rootActiveSessionId': 'active-id', 'supervisorSocketPath': '/fixture.sock'}
            path = descriptors / 'different-worker-id.json'
            path.write_text(json.dumps(row))
            self.assertEqual(worker_descriptor(agent, 'active-id', Path('/fixture.sock')), (path, row))

    def test_ts_and_rust_worker_socket_seams_are_both_checked(self):
        row = {'pid': 123, 'rootActiveSessionId': 'fixture', 'supervisorSocketPath': '/fixture/d.sock',
               'socketPath': '/fixture/worker.sock', 'processStartId': 'proc:456'}
        env = b'PRIME_AGENT_INTERNAL_DAEMON_WORKER=1\0PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID=fixture\0PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET=/fixture/d.sock\0'
        for command, extra in [
            (b'/fixture/binary\0--mode\0daemon\0--daemon-socket\0/fixture/worker.sock\0', b''),
            (b'/fixture/binary\0worker\0', b'PRIME_AGENT_INTERNAL_DAEMON_WORKER_SOCKET=/fixture/worker.sock\0'),
        ]:
            with patch('pathlib.Path.read_bytes', side_effect=[command, env + extra]), \
                    patch('review_launch_env_parity.process_identity', return_value=('proc:456', 'S')):
                self.assertEqual(verify_worker(row, 'fixture', Path('/fixture/binary'), Path('/fixture/d.sock')), (123, 'proc:456'))

    def test_reused_pid_is_rejected(self):
        row = {'pid': 123, 'rootActiveSessionId': 'fixture', 'supervisorSocketPath': '/fixture/d.sock',
               'socketPath': '/fixture/worker.sock', 'processStartId': 'proc:old'}
        command = b'/fixture/binary\0--mode\0daemon\0/fixture/worker.sock\0'
        env = b'PRIME_AGENT_INTERNAL_DAEMON_WORKER=1\0PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID=fixture\0PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET=/fixture/d.sock\0'
        with patch('pathlib.Path.read_bytes', side_effect=[command, env]), \
                patch('review_launch_env_parity.process_identity', return_value=('proc:new', 'S')):
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

    def test_known_filter_difference_does_not_hide_other_env_difference(self):
        ts = {'phase': {'env': {'PA_ENV_MARKER': 'same', 'PRIME_AGENT_INTERNAL_PARITY_CANARY': 'injected'}}}
        rust = {'phase': {'env': {'PA_ENV_MARKER': 'same', 'PRIME_AGENT_INTERNAL_PARITY_CANARY': None}}}
        self.assertEqual(comparable_probes(ts), comparable_probes(rust))
        rust['phase']['env']['PA_ENV_MARKER'] = 'wrong'
        self.assertNotEqual(comparable_probes(ts), comparable_probes(rust))
        self.assertEqual(ts['phase']['env']['PRIME_AGENT_INTERNAL_PARITY_CANARY'], 'injected')

    def test_ts_resident_reopens_exact_file_with_empty_fresh_context(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / 'descriptor.json'
            failed = {'pid': 123, 'rootActiveSessionId': 'old-active', 'lifecycle': 'failed',
                'lastError': 'Waiting for a client with fresh runtime context'}
            path.write_text(json.dumps(failed))
            session = {'sessionId': 'durable-id', 'sessionFile': str(root / 'session.jsonl')}
            created = {**session, 'activeSessionId': 'new-active'}
            client = MagicMock()
            client.call.side_effect = lambda kind, **data: created if kind == 'create' else session
            observed = {}
            with patch('review_launch_env_parity.worker_descriptor', side_effect=[(path, failed), (root / 'new-descriptor.json', {'pid': 456})]), \
                    patch('review_launch_env_parity.verify_worker', side_effect=[(123, 'proc:old'), (456, 'proc:new')]), \
                    patch('review_launch_env_parity.wait_gone'), patch('os.kill'):
                active = restart(client, 'old-active', root / 'agent', root / 'binary', {'cwd': str(root)},
                    False, observed, set(), 'ts', session)
            self.assertEqual(active, 'new-active')
            self.assertEqual(observed['parked_descriptor'], failed)
            create = [call for call in client.call.call_args_list if call.args == ('create',)]
            self.assertEqual(len(create), 1)
            self.assertEqual(create[0].kwargs['sessionPath'], session['sessionFile'])
            self.assertEqual(create[0].kwargs['launchEnv'], {})
            self.assertEqual(observed['replacement_state'], session)

    def test_ts_fresh_create_cannot_switch_durable_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / 'descriptor.json'
            failed = {'pid': 123, 'rootActiveSessionId': 'old-active', 'lifecycle': 'failed',
                'lastError': 'Waiting for a client with fresh runtime context'}
            path.write_text(json.dumps(failed))
            session = {'sessionId': 'durable-id', 'sessionFile': str(root / 'session.jsonl')}
            client = MagicMock()
            client.call.return_value = {**session, 'sessionId': 'wrong-id', 'activeSessionId': 'new-active'}
            with patch('review_launch_env_parity.worker_descriptor', return_value=(path, failed)), \
                    patch('review_launch_env_parity.verify_worker', return_value=(123, 'proc:old')), \
                    patch('review_launch_env_parity.wait_gone'), patch('os.kill'):
                with self.assertRaisesRegex(AssertionError, 'changed durable session identity'):
                    restart(client, 'old-active', root / 'agent', root / 'binary', {}, False,
                        {}, set(), 'ts', session)


if __name__ == '__main__':
    unittest.main()
