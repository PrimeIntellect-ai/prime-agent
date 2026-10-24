#!/usr/bin/env python3
"""Ensure the differential verifier does not hide user-visible text changes."""
import unittest

from review_hooks_parity import conversation


class ConversationEvidenceTests(unittest.TestCase):
    def test_preserves_exact_text_order_and_ignores_metadata(self):
        rows = [
            {'type': 'session', 'id': 'generated'},
            {'type': 'message', 'message': {'role': 'user', 'content': ' keep whitespace '}},
            {'type': 'custom', 'message': {'role': 'user', 'content': 'not conversation'}},
            {'type': 'message', 'message': {'role': 'assistant', 'content': [
                {'type': 'thinking', 'thinking': 'internal'},
                {'type': 'text', 'text': 'first\n'}, {'type': 'text', 'text': 'second'}]}},
        ]
        self.assertEqual(conversation(rows), [
            {'role': 'user', 'text': ' keep whitespace '},
            {'role': 'assistant', 'text': 'first\nsecond'}])

    def test_does_not_hide_duplicate_or_empty_turns(self):
        row = {'type': 'message', 'message': {'role': 'assistant', 'content': []}}
        self.assertEqual(conversation([row, row]), [
            {'role': 'assistant', 'text': ''}, {'role': 'assistant', 'text': ''}])


if __name__ == '__main__':
    unittest.main()
