#!/usr/bin/env python3
"""Check receipt parsing rejects historical or non-completed assistant output."""
from pathlib import Path
from unittest.mock import patch
import unittest

from check_custom_ca import ANSWER, PROMPT, confirm_cleanup, terminal_assistant, request_contract


class ReceiptParsingTests(unittest.TestCase):
    def test_one_terminal_assistant_required(self):
        message = {'role': 'assistant', 'stopReason': 'stop',
                   'content': [{'type': 'text', 'text': ANSWER}]}
        self.assertEqual(terminal_assistant([{'role': 'user', 'content': PROMPT}, message]), message)
        with self.assertRaises(AssertionError):
            terminal_assistant([message, message])

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

    def test_shutdown_failure_remains_red(self):
        with patch('check_custom_ca.owned_processes', return_value={}):
            with self.assertRaises(AssertionError):
                confirm_cleanup(Path('/unused'), {'shutdown_error': 'fixture shutdown refused'})


if __name__ == '__main__':
    unittest.main()
