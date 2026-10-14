#!/usr/bin/env python3
"""Lightweight guards on the comparator's strict normalization and raw capture."""
import io
import unittest
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

    def test_raw_read_keeps_json_spacing_and_line_ending(self):
        payload = b'{ "response": true }\n'
        wire = []
        reader = RecordedIO(io.BytesIO(payload), wire, 'in')
        self.assertEqual(reader.readline(), payload)
        self.assertEqual(wire, [{'direction': 'in', 'utf8': payload.decode()}])


if __name__ == '__main__':
    unittest.main()
