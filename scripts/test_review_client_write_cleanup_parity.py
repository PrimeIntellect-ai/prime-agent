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
        second.call.side_effect = RuntimeError('primary enqueue failure')
        process = Mock(poll=Mock(return_value=None))
        observed = {}
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(verifier, 'Provider', return_value=provider), patch.object(verifier.threading, 'Thread'), patch.object(verifier, 'WireClient', side_effect=[observer, attached, second]), patch.object(verifier.subprocess, 'Popen', return_value=process), patch.object(verifier, 'stop'), patch.object(verifier, 'settle_owned_processes'):
                with self.assertRaisesRegex(RuntimeError, '^primary enqueue failure$'):
                    verifier.run_case(Path('/fixture/binary'), 'ts', Path(folder), observed)
        self.assertEqual(observed['primary_error'], 'primary enqueue failure')
        self.assertEqual(observed['cleanup_error'], 'cleanup failed')
        self.assertFalse(observed['verified'])
        self.assertEqual(second.call.call_args.kwargs['streamingBehavior'], 'followUp')

    def test_raw_read_keeps_json_spacing_and_line_ending(self):
        payload = b'{ "response": true }\n'
        wire = []
        reader = RecordedIO(io.BytesIO(payload), wire, 'in')
        self.assertEqual(reader.readline(), payload)
        self.assertEqual(wire, [{'direction': 'in', 'utf8': payload.decode()}])


if __name__ == '__main__':
    unittest.main()
