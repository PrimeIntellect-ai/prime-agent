import unittest
from review_queue_browse_parity import check_mutation, USER_A


class QueueBrowseGuardTest(unittest.TestCase):
    def command(self, direction):
        return {'type': 'mutate_queued_message', 'activeSessionId': 's1', 'lane': 'steering',
            'index': 0, 'expectedText': USER_A, 'mutation': {'type': 'move', 'direction': direction}}

    def test_compares_actual_mutation_target_with_explicit_ts_delta(self):
        check_mutation('ts', self.command(1))
        check_mutation('rust', self.command(2))
        with self.assertRaises(AssertionError):
            check_mutation('rust', self.command(1))
        with self.assertRaises(AssertionError):
            check_mutation('ts', self.command(2))

    def test_rejects_wrong_source_lane_text_or_index(self):
        for field, value in [('lane', 'followUp'), ('index', 1), ('expectedText', 'wrong')]:
            command = self.command(2)
            command[field] = value
            with self.assertRaises(AssertionError):
                check_mutation('rust', command)


if __name__ == '__main__':
    unittest.main()
