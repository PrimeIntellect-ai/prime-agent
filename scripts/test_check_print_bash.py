#!/usr/bin/env python3
import copy
import unittest
from check_print_bash import validate


class PrintBashGuards(unittest.TestCase):
    def test_requires_release_after_first_turn_and_one_real_completion(self):
        good = {'first_turn_ended_before_release': True, 'request_count': 4,
                'finished': {'completed': True}, 'notice': {
                    'exit_code': 0, 'display': True, 'matches_started_pid': True}}
        validate(good)
        for key, value in [('first_turn_ended_before_release', False),
                           ('request_count', 2), ('request_count', 5),
                           ('finished', {'completed': False})]:
            changed = {**copy.deepcopy(good), key: value}
            with self.assertRaises(AssertionError):
                validate(changed)
        for key, value in [('exit_code', 1), ('display', False), ('matches_started_pid', False)]:
            changed = copy.deepcopy(good)
            changed['notice'][key] = value
            with self.assertRaises(AssertionError):
                validate(changed)


if __name__ == '__main__':
    unittest.main()
