#!/usr/bin/env python3
"""Guard scope separation between initial headless availability and restored state."""
import copy
import unittest

from check_restore_notice import SKILL_PROBE, skill_availability


HIDDEN = {'preimports': {'agent_message': True, 'agent_observe': False, 'rlm_heartbeat': False},
          'model_visible': {'agent-message': True, 'agent-observe': False, 'rlm-heartbeat': False}}


class AvailabilityTests(unittest.TestCase):
    def test_observation_uses_actual_tool_result_and_inventory(self):
        requests = [
            {'messages': [{'role': 'system', 'content': '<available_skills><skill><name>agent-message</name></skill></available_skills>'}]},
            {'messages': [{'role': 'tool', 'content': SKILL_PROBE + '{"agent_message":true,"agent_observe":false,"rlm_heartbeat":false}'}]}]
        self.assertEqual(skill_availability(requests), HIDDEN)
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
