#!/usr/bin/env python3
"""Focused checks for the binary verifier's evidence parsing and assertions."""
import copy
import json
import unittest

from review_model_facts_parity import MARKER, MODELS, latest_probe, verify_probe, compare


def probe(model, count):
    return {'kernel_probe_count': count,
            'model_info': {'provider': 'fixture', 'id': model['id'], 'input': model['input']},
            'compact_status': {'context_window': model['contextWindow'], 'scheduled': False,
                               'tokens': 11, 'percent': 0.1}}


class VerifierTests(unittest.TestCase):
    def test_latest_tool_result_wins_over_retained_history_and_tool_arguments(self):
        old, new = probe(MODELS[0], 1), probe(MODELS[1], 2)
        body = {'messages': [
            {'role': 'tool', 'content': MARKER + json.dumps(old)},
            {'role': 'assistant', 'content': MARKER + json.dumps(old)},
            {'role': 'tool', 'content': [{'type': 'text', 'text': MARKER + json.dumps(new)}]}]}
        self.assertEqual(latest_probe(body), new)

    def test_stale_live_model_and_window_are_rejected(self):
        live = probe(MODELS[1], 2)
        verify_probe(live, MODELS[1], 2)
        for member in ('model_info', 'compact_status'):
            stale = copy.deepcopy(live)
            stale[member] = probe(MODELS[0], 2)[member]
            with self.assertRaises(AssertionError):
                verify_probe(stale, MODELS[1], 2)

    def test_rebuilt_kernel_is_rejected(self):
        with self.assertRaises(AssertionError):
            verify_probe(probe(MODELS[1], 1), MODELS[1], 2)

    def test_usage_differences_are_retained_and_disclosed(self):
        ts = [probe(model, i + 1) for i, model in enumerate([MODELS[0], MODELS[1], MODELS[0]])]
        rust = copy.deepcopy(ts)
        rust[1]['compact_status']['tokens'] = 19
        result = {'runs': {'ts': {'probes': ts}, 'rust': {'probes': rust}}}
        compare(result)
        self.assertEqual(result['complete_compact_status_equal'], [True, False, True])
        self.assertEqual(result['runs']['rust']['probes'][1]['compact_status']['tokens'], 19)
        rust[1]['compact_status']['context_window'] = 128000
        with self.assertRaises(AssertionError):
            compare(result)


if __name__ == '__main__':
    unittest.main()
