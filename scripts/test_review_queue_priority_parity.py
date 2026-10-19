import unittest
from review_queue_priority_parity import check_order, EARLIER, EDITED, AGENT


class QueuePriorityGuardTest(unittest.TestCase):
    def test_records_the_intended_delta_instead_of_accepting_both_orders(self):
        ts = {'steering': [EARLIER, AGENT, EDITED], 'followUp': []}
        rust = {'steering': [EARLIER, EDITED, AGENT], 'followUp': []}
        check_order('ts', ts, AGENT)
        check_order('rust', rust, AGENT)
        with self.assertRaises(AssertionError):
            check_order('rust', ts, AGENT)
        with self.assertRaises(AssertionError):
            check_order('ts', rust, AGENT)

    def test_does_not_ignore_missing_duplicate_or_wrong_lane_items(self):
        for queue in [
            {'steering': [EDITED, AGENT], 'followUp': []},
            {'steering': [EARLIER, EDITED, AGENT, AGENT], 'followUp': []},
            {'steering': [EARLIER, EDITED, AGENT], 'followUp': [EDITED]},
        ]:
            with self.assertRaises(AssertionError):
                check_order('rust', queue, AGENT)


if __name__ == '__main__':
    unittest.main()
