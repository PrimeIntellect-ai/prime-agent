#!/usr/bin/env python3
"""Guard scope separation between initial headless availability and restored state."""
import copy
import unittest

from review_restore_notice_parity import SKILL_PROBE, skill_availability, validate_skill_availability


def run(available):
    return {'skill_availability': {
        'preimports': {'agent_message': True, 'agent_observe': available,
                       'rlm_heartbeat': available},
        'model_visible': {'agent-message': True, 'agent-observe': available,
                          'rlm-heartbeat': available}}}


class AvailabilityTests(unittest.TestCase):
    def test_declared_initial_difference_is_exact(self):
        validate_skill_availability({'ts': run(True), 'rust': run(False)})

    def test_unexpected_inventory_or_preimport_changes_fail(self):
        for label in ['ts', 'rust']:
            for kind in ['preimports', 'model_visible']:
                for name in run(True)['skill_availability'][kind]:
                    rows = {'ts': run(True), 'rust': run(False)}
                    actual = rows[label]['skill_availability'][kind]
                    actual[name] = not actual[name]
                    with self.assertRaises(AssertionError):
                        validate_skill_availability(rows)

    def test_observation_uses_actual_tool_result_and_inventory(self):
        requests = [
            {'messages': [{'role': 'system', 'content': '<available_skills><skill><name>agent-message</name></skill></available_skills>'}]},
            {'messages': [{'role': 'tool', 'content': SKILL_PROBE + '{"agent_message":true,"agent_observe":false,"rlm_heartbeat":false}'}]}]
        self.assertEqual(skill_availability(requests), run(False)['skill_availability'])
        broken = copy.deepcopy(requests)
        broken[0]['messages'][0]['content'] = 'agent-message'
        with self.assertRaises(AssertionError):
            skill_availability(broken)
        broken = copy.deepcopy(requests)
        broken[1]['messages'][0]['role'] = 'assistant'
        with self.assertRaises(AssertionError):
            skill_availability(broken)


if __name__ == '__main__':
    unittest.main()
