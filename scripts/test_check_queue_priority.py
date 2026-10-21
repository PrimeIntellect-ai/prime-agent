import unittest
from check_queue_priority import check_order, EARLIER, EDITED, AGENT


class QueuePriorityGuardTest(unittest.TestCase):
    def test_edited_item_keeps_priority_over_the_later_agent_message(self):
        check_order({'steering': [EARLIER, EDITED, AGENT], 'followUp': []}, AGENT)
        with self.assertRaises(AssertionError):
            check_order({'steering': [EARLIER, AGENT, EDITED], 'followUp': []}, AGENT)

    def test_does_not_ignore_missing_duplicate_or_wrong_lane_items(self):
        for queue in [
            {'steering': [EDITED, AGENT], 'followUp': []},
            {'steering': [EARLIER, EDITED, AGENT, AGENT], 'followUp': []},
            {'steering': [EARLIER, EDITED, AGENT], 'followUp': [EDITED]},
        ]:
            with self.assertRaises(AssertionError):
                check_order(queue, AGENT)


if __name__ == '__main__':
    unittest.main()
