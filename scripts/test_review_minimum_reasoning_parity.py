#!/usr/bin/env python3
"""Keep actual behavior gates and graceful fixture cleanup inseparable."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from review_goal_fixture_lifecycle import OwnedProcesses
from review_minimum_reasoning_parity import MARKER, run_case, summarize_branch, wait_for_operation


class CleanupTests(unittest.TestCase):
    def exercise(self, root, *, cleanup_failure=False, controls=True, durable=True):
        library = root / 'library'
        for skill in ('compact', 'refine'):
            path = library / 'skills' / skill / 'src' / skill / '__init__.py'
            path.parent.mkdir(parents=True)
            path.touch()
        case = root / 'case'
        events = []
        server, process, client, scope, thread = (MagicMock() for _ in range(5))
        process.returncode = 0
        scope.targets = {}
        scope.errors = []
        scope.live.return_value = []
        thread.is_alive.return_value = False
        server.server_address = ('127.0.0.1', 1234)
        server.error = None
        server.requests = [
            {'auxiliary': False, 'body': {'messages': [
                {'role': 'tool', 'content': MARKER + '{"scheduled":true}'}]}},
            {'auxiliary': True, 'body': {'enable_thinking': controls}},
        ]
        def spawn(*args, **kwargs):
            (case / 'sessions' / 'fixture.jsonl').write_text(
                json.dumps({'type': 'compaction'}) + '\n' if durable else '')
            return process
        def command(kind, **kwargs):
            events.append(kind)
            return {'id': 'active'} if kind == 'create' else {}
        client.call.side_effect = command
        client.close.side_effect = lambda: events.append('control_closed')
        process.wait.side_effect = lambda **kwargs: events.append('supervisor_exit')
        if cleanup_failure:
            scope.wait_gone.side_effect = [AssertionError('owned process remained'), None]
        else:
            scope.wait_gone.side_effect = lambda timeout: events.append('owned_processes_exited')
        observation = {}
        with patch.dict('os.environ', {'PI_PACKAGE_DIR': str(library)}), \
                patch('review_minimum_reasoning_parity.Server', return_value=server), \
                patch('review_minimum_reasoning_parity.threading.Thread', return_value=thread), \
                patch('review_minimum_reasoning_parity.invoke', return_value={'exit_code': 0}), \
                patch('review_minimum_reasoning_parity.subprocess.Popen', side_effect=spawn), \
                patch('review_minimum_reasoning_parity.KernelClient', return_value=client), \
                patch('review_minimum_reasoning_parity.OwnedProcesses', return_value=scope):
            result = run_case(Path('/fixture/binary'), 'rust', 'compact', case, observation)
        return result, observation, events

    def test_daemon_commands_and_owned_exit_precede_directory_removal(self):
        with tempfile.TemporaryDirectory() as temp:
            result, observation, events = self.exercise(Path(temp))
            self.assertEqual(result, {'scheduled': True, 'completed': True})
            self.assertTrue(observation['cleanup_verified'])
            self.assertEqual(events, ['create', 'prompt_and_wait', 'prompt_and_wait',
                'shutdown', 'control_closed', 'supervisor_exit', 'owned_processes_exited',
                'control_closed'])

    def test_fallback_reaping_cannot_turn_failed_graceful_cleanup_green(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(AssertionError, 'fixture cleanup failed: owned process remained'):
                self.exercise(Path(temp), cleanup_failure=True)

    def test_cleanup_cannot_hide_incorrect_thinking_controls(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(AssertionError, 'expected'):
                self.exercise(Path(temp), controls=False)

    def test_cleanup_cannot_hide_missing_durable_outcome(self):
        with tempfile.TemporaryDirectory() as temp, \
                patch('review_minimum_reasoning_parity.time.monotonic', side_effect=[0, 91]):
            with self.assertRaisesRegex(AssertionError, 'timed out waiting.*durable compact outcome'):
                self.exercise(Path(temp), durable=False)

    def test_turn_idle_does_not_end_wait_before_continuation_probe(self):
        with tempfile.TemporaryDirectory() as temp:
            sessions = Path(temp)
            (sessions / 'session.jsonl').write_text(json.dumps({'type': 'compaction'}) + '\n')
            server = MagicMock(error=None, requests=[])
            event = MagicMock()
            event.wait.side_effect = lambda _timeout: server.requests.append({'body': {
                'messages': [{'role': 'tool', 'content': MARKER + '{"scheduled":true}'}]}})
            with patch('review_minimum_reasoning_parity.threading.Event', return_value=event):
                self.assertEqual(wait_for_operation(server, 'compact', sessions),
                    ({'scheduled': True}, [{'type': 'compaction'}]))
            event.wait.assert_called_once_with(0.025)

    def test_probe_does_not_end_wait_before_durable_operation_outcome(self):
        with tempfile.TemporaryDirectory() as temp:
            sessions = Path(temp)
            server = MagicMock(error=None, requests=[{'body': {'messages': [
                {'role': 'tool', 'content': MARKER + '{"scheduled":true}'}]}}])
            event = MagicMock()
            event.wait.side_effect = lambda _timeout: (sessions / 'session.jsonl').write_text(
                json.dumps({'type': 'refinement_outcome', 'customType': 'refinement_outcome'}) + '\n')
            with patch('review_minimum_reasoning_parity.threading.Event', return_value=event):
                scheduled, outcomes = wait_for_operation(server, 'refine', sessions)
            self.assertEqual(scheduled, {'scheduled': True})
            self.assertEqual(len(outcomes), 1)
            event.wait.assert_called_once_with(0.025)

    def test_invalid_current_probe_is_not_retried_until_it_disappears(self):
        with tempfile.TemporaryDirectory() as temp:
            server = MagicMock(error=None, requests=[{'body': {'messages': [
                {'role': 'tool', 'content': MARKER + 'invalid-json'}]}}])
            with patch('review_minimum_reasoning_parity.threading.Event') as event:
                with self.assertRaises(json.JSONDecodeError):
                    wait_for_operation(server, 'compact', Path(temp))
                event.assert_not_called()

    def test_torn_utf8_tail_waits_for_a_complete_session_record(self):
        with tempfile.TemporaryDirectory() as temp:
            sessions = Path(temp)
            path = sessions / 'session.jsonl'
            path.write_bytes(b'{"type":"compaction","note":"\xc3')
            server = MagicMock(error=None, requests=[{'body': {'messages': [
                {'role': 'tool', 'content': MARKER + '{"scheduled":true}'}]}}])
            event = MagicMock()
            event.wait.side_effect = lambda _timeout: path.write_text('{"type":"compaction"}\n')
            with patch('review_minimum_reasoning_parity.threading.Event', return_value=event):
                self.assertEqual(wait_for_operation(server, 'compact', sessions),
                    ({'scheduled': True}, [{'type': 'compaction'}]))
            event.wait.assert_called_once_with(0.025)

    def test_file_replaced_between_listing_and_read_is_pending(self):
        with tempfile.TemporaryDirectory() as temp:
            sessions = Path(temp)
            (sessions / 'session.jsonl').write_text('{"type":"compaction"}\n')
            server = MagicMock(error=None, requests=[{'body': {'messages': [
                {'role': 'tool', 'content': MARKER + '{"scheduled":true}'}]}}])
            event = MagicMock()
            with patch('pathlib.Path.read_bytes', side_effect=[FileNotFoundError(), b'{"type":"compaction"}\n']), \
                    patch('review_minimum_reasoning_parity.threading.Event', return_value=event):
                self.assertEqual(wait_for_operation(server, 'compact', sessions),
                    ({'scheduled': True}, [{'type': 'compaction'}]))
            event.wait.assert_called_once_with(0.025)

    def test_complete_malformed_record_and_permission_errors_are_failures(self):
        with tempfile.TemporaryDirectory() as temp:
            sessions = Path(temp)
            path = sessions / 'session.jsonl'
            path.write_text('invalid-json\n')
            server = MagicMock(error=None, requests=[{'body': {'messages': [
                {'role': 'tool', 'content': MARKER + '{"scheduled":true}'}]}}])
            with patch('review_minimum_reasoning_parity.threading.Event') as event:
                with self.assertRaises(json.JSONDecodeError):
                    wait_for_operation(server, 'compact', sessions)
                with patch('pathlib.Path.read_bytes', side_effect=PermissionError()):
                    with self.assertRaises(PermissionError):
                        wait_for_operation(server, 'compact', sessions)
                event.assert_not_called()

    def test_branch_uses_live_session_and_real_assistant_target(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'session.jsonl'
            path.write_text(json.dumps({'type': 'message', 'id': 'assistant',
                'message': {'role': 'assistant'}}))
            client = MagicMock()
            client.call.return_value = {}
            summarize_branch(client, 'active', path)
            client.call.assert_called_once_with('navigate_tree', timeout_seconds=60,
                activeSessionId='active', targetId='assistant', summarize=True,
                customInstructions='Verify mandatory thinking')
            client.call.return_value = {'cancelled': True}
            with self.assertRaises(AssertionError):
                summarize_branch(client, 'active', path)

    def test_proc_exit_race_is_gone_but_permission_errors_still_fail(self):
        scope = OwnedProcesses(Path('/fixture/binary'), Path('/fixture'), Path('/fixture/d.sock'))
        scope.targets = {789: 'proc:123'}
        with patch('review_goal_fixture_lifecycle.process_identity', side_effect=ProcessLookupError()):
            self.assertEqual(scope.live(), [])
        with patch('review_goal_fixture_lifecycle.process_identity', side_effect=PermissionError()):
            with self.assertRaises(PermissionError):
                scope.live()


if __name__ == '__main__':
    unittest.main()
