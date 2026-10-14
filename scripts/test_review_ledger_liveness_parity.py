#!/usr/bin/env python3
"""Guard the real-wire family receipt against duplicate or unrelated children."""
import tempfile
from pathlib import Path
import unittest

from review_ledger_liveness_parity import NAME, family_contract


class FamilyReceiptTests(unittest.TestCase):
    def test_duplicates_do_not_prove_one_child(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'child.jsonl'
            path.write_text('{}')
            row = {'rlmChildId': 'child', 'sessionName': NAME, 'rlmDepth': 1,
                   'parentActiveSessionId': 'parent', 'sessionFile': str(path)}
            with self.assertRaises(AssertionError):
                family_contract([row, row], 'child', 'parent')

    def test_unrelated_parent_is_not_normalized_away(self):
        row = {'rlmChildId': 'child', 'sessionName': NAME, 'rlmDepth': 1,
               'parentActiveSessionId': 'different-parent', 'sessionFile': '/unused'}
        with self.assertRaises(AssertionError):
            family_contract([row], 'child', 'parent')

    def test_generated_paths_only_normalize_after_real_file_check(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'child.jsonl'
            row = {'rlmChildId': 'child', 'sessionName': NAME, 'rlmDepth': 1,
                   'parentActiveSessionId': 'parent', 'sessionFile': str(path)}
            with self.assertRaises(AssertionError):
                family_contract([row], 'child', 'parent')
            path.write_text('{}')
            self.assertTrue(family_contract([row], 'child', 'parent')['transcript_exists'])


if __name__ == '__main__':
    unittest.main()
