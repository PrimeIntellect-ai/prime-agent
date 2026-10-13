#!/usr/bin/env python3
"""Guard the binary verifier against historical tool-result false positives."""
import json
import unittest

from review_local_harness_parity import current_probe, MARKER


def request(current_content=None):
    messages = [
        {'role': 'assistant', 'tool_calls': [{'id': 'call_setup'}]},
        {'role': 'tool', 'tool_call_id': 'call_setup', 'content': MARKER + json.dumps({'old': True})},
        {'role': 'assistant', 'tool_calls': [{'id': 'call_resume'}]},
    ]
    if current_content is not None:
        messages.append({'role': 'tool', 'tool_call_id': 'call_resume', 'content': current_content})
    return [{'messages': messages}]


class CurrentProbeTests(unittest.TestCase):
    def test_resume_returns_new_marker_with_old_marker_in_history(self):
        self.assertEqual(current_probe(request(MARKER + json.dumps({'new': True})), 'resume'),
                         {'new': True})

    def test_failing_current_cell_cannot_pass_using_old_marker(self):
        with self.assertRaisesRegex(AssertionError, 'current phase probe'):
            current_probe(request('Traceback: current resume cell failed'), 'resume')

    def test_missing_current_result_cannot_pass_using_old_marker(self):
        with self.assertRaisesRegex(AssertionError, 'current phase tool result'):
            current_probe(request(), 'resume')


if __name__ == '__main__':
    unittest.main()
