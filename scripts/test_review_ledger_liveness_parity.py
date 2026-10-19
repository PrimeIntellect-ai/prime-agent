#!/usr/bin/env python3
"""Guard the real-wire family receipt against duplicate or unrelated children."""
import tempfile
from unittest.mock import patch
from pathlib import Path
import unittest

from review_ledger_liveness_parity import NAME, MARKER, admitted_probe, archive_restore_unsupported, catalog_row, confirm_cleanup, family_contract


class FamilyReceiptTests(unittest.TestCase):
    def test_only_exact_actual_archive_refusal_is_classified_unsupported(self):
        row = {'type': 'response', 'command': 'send_message', 'success': False,
               'error': 'Unknown active session: saved-id'}
        self.assertTrue(archive_restore_unsupported(row, 'saved-id'))
        for changed in ({'success': True}, {'error': 'Request timed out'},
                        {'error': 'Unknown active session: different-id'}, {'command': 'kill'}):
            self.assertFalse(archive_restore_unsupported({**row, **changed}, 'saved-id'))

    def test_duplicate_catalog_paths_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'child.jsonl'
            row = {'path': str(path), 'id': 'child'}
            with self.assertRaises(AssertionError):
                catalog_row({'sessions': [row, row]}, path)

    def test_catalog_selection_does_not_accept_a_matching_id_at_an_unrelated_path(self):
        row = {'path': '/unrelated/child.jsonl', 'id': 'child'}
        with self.assertRaises(AssertionError):
            catalog_row({'sessions': [row]}, Path('/fixture/child.jsonl'))

    def test_duplicate_current_probes_fail(self):
        text = MARKER + '{"child_id":"child"}'
        with self.assertRaises(AssertionError):
            admitted_probe({'messages': [{'role': 'tool', 'tool_call_id': 'ledger_spawn',
                                         'content': text + '\n' + text}]})

    def test_duplicate_current_tool_results_fail(self):
        row = {'role': 'tool', 'tool_call_id': 'ledger_spawn',
               'content': MARKER + '{"child_id":"child"}'}
        with self.assertRaises(AssertionError):
            admitted_probe({'messages': [row, row]})

    def test_shutdown_failure_cannot_be_a_green_receipt(self):
        with patch('review_ledger_liveness_parity.owned_processes', return_value={}):
            with self.assertRaises(AssertionError):
                confirm_cleanup(Path('/unused'), {'shutdown_error': 'shutdown refused'})

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
