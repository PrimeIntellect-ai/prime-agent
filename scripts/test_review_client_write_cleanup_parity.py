#!/usr/bin/env python3
"""Lightweight guards on the comparator's strict normalization and raw capture."""
import io
import unittest
from pathlib import Path
import tempfile
from unittest.mock import Mock, patch
import review_client_write_cleanup_parity as verifier
from review_client_write_cleanup_parity import RecordedIO, canonical


class ComparatorTests(unittest.TestCase):
    def test_only_pause_identity_is_normalized(self):
        baseline = {'pauseId': 'generated-A', 'error': 'denied', 'nested': {'id': 'keep'}}
        equivalent = {'pauseId': 'generated-B', 'error': 'denied', 'nested': {'id': 'keep'}}
        changed = {'pauseId': 'generated-B', 'error': 'allowed', 'nested': {'id': 'keep'}}
        self.assertEqual(canonical(baseline), canonical(equivalent))
        self.assertNotEqual(canonical(baseline), canonical(changed))
        self.assertEqual(canonical(baseline)['nested'], {'id': 'keep'})
        self.assertEqual(baseline['pauseId'], 'generated-A')

    def test_primary_failure_survives_a_shutdown_failure(self):
        provider = Mock(server_port=1)
        observer = Mock(raw_wire=[], wire=[])
        observer.call.side_effect = [{'activeSessionId': 'fixture-session'}, RuntimeError('cleanup failed')]
        attached = Mock(raw_wire=[], wire=[])
        attached.call.side_effect = [None, None, {'pauseId': 'fixture-pause'}]
        second = Mock(raw_wire=[], wire=[])
        second.call.side_effect = [{'attachedClients': 1}, None, {'attachedClients': 0}, RuntimeError('primary enqueue failure')]
        process = Mock(poll=Mock(return_value=None))
        observed = {}
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(verifier, 'Provider', return_value=provider), patch.object(verifier.threading, 'Thread'), patch.object(verifier, 'WireClient', side_effect=[observer, attached, second]), patch.object(verifier.subprocess, 'Popen', return_value=process), patch.object(verifier, 'stop'), patch.object(verifier, 'settle_owned_processes'), patch.object(verifier, 'pause_released', side_effect=[False, True]):
                with self.assertRaisesRegex(RuntimeError, '^primary enqueue failure$'):
                    verifier.run_case(Path('/fixture/binary'), 'ts', Path(folder), observed)
        self.assertEqual(observed['primary_error'], 'primary enqueue failure')
        self.assertEqual(observed['cleanup_error'], 'cleanup failed')
        self.assertFalse(observed['verified'])
        self.assertEqual(second.call.call_args.kwargs['streamingBehavior'], 'followUp')

    def test_rename_trigger_deviation_rejects_unexpected_data(self):
        verifier.validate_rename_trigger('ts', None, 'session')
        with self.assertRaises(AssertionError):
            verifier.validate_rename_trigger('ts', {}, 'session')
        summary = {'activeSessionId': 'session', 'sessionName': 'Write cleanup fixture', 'workerPid': 123}
        verifier.validate_rename_trigger('rust', summary, 'session')
        for changed in (None, {**summary, 'activeSessionId': 'another'}, {**summary, 'sessionName': 'wrong'}, {**summary, 'workerPid': None}):
            with self.assertRaises(AssertionError):
                verifier.validate_rename_trigger('rust', changed, 'session')

    def test_nonowner_probe_does_not_hide_other_errors(self):
        response = {'command': 'release_session_input_pause', 'success': False,
                    'error': 'Session input pause is owned by another client: lease'}
        client = Mock(wire=[response])
        client.call.side_effect = AssertionError(response)
        self.assertFalse(verifier.pause_released(client, 'session', 'lease'))
        client.wire[-1] = {**response, 'error': 'Unexpected worker failure'}
        with self.assertRaises(AssertionError):
            verifier.pause_released(client, 'session', 'lease')
        client.call.side_effect = None
        self.assertTrue(verifier.pause_released(client, 'session', 'lease'))

    def test_raw_read_keeps_json_spacing_and_line_ending(self):
        payload = b'{ "response": true }\n'
        wire = []
        reader = RecordedIO(io.BytesIO(payload), wire, 'in')
        self.assertEqual(reader.readline(), payload)
        self.assertEqual(wire, [{'direction': 'in', 'utf8': payload.decode()}])


if __name__ == '__main__':
    unittest.main()
