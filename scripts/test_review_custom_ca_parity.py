#!/usr/bin/env python3
"""Check receipt parsing rejects historical or non-completed assistant output."""
import json
import unittest

from review_custom_ca_parity import ANSWER, PROMPT, completed_messages, request_contract


class ReceiptParsingTests(unittest.TestCase):
    def test_only_completed_assistant_messages_count(self):
        rows = [
            {'type': 'message_start', 'message': {'role': 'assistant', 'content': ANSWER}},
            {'type': 'message_end', 'message': {'role': 'user', 'content': PROMPT}},
            {'type': 'message_end', 'message': {'role': 'assistant', 'stopReason': 'stop',
                                             'content': [{'type': 'text', 'text': ANSWER}]}},
        ]
        self.assertEqual(completed_messages('\n'.join(map(json.dumps, rows))), [rows[-1]['message']])

    def test_duplicate_current_prompt_is_not_normalized_away(self):
        request = {'path': '/v1/chat/completions', 'authorization': 'Bearer fixture-only',
                   'body': {'model': 'ca-fixture', 'stream': True,
                            'messages': [{'role': 'system', 'content': 'fixture system'},
                                         {'role': 'user', 'content': PROMPT},
                                         {'role': 'user', 'content': PROMPT}]}}
        with self.assertRaises(AssertionError):
            request_contract(request)
        request['body']['messages'][1]['content'] = '[harness-digest] actual runtime digest'
        self.assertEqual(request_contract(request)['current_prompt_count'], 1)

    def test_malformed_json_is_a_failure(self):
        with self.assertRaises(json.JSONDecodeError):
            completed_messages('{broken')


if __name__ == '__main__':
    unittest.main()
