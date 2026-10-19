import unittest
from review_dead_child_delete_parity import delete_contract


class DeleteReceiptGuards(unittest.TestCase):
    def test_requires_exact_child_delete_boundary(self):
        valid = {'op': 'delete', 'childId': 'child', 'reason': 'user'}
        self.assertEqual(delete_contract([valid], 'child'), [valid])
        for rows in [[], [{**valid, 'childId': 'other'}], [{**valid, 'op': 'spawn'}],
                     [{**valid, 'reason': 'unknown'}]]:
            with self.assertRaises(AssertionError):
                delete_contract(rows, 'child')


if __name__ == '__main__':
    unittest.main()
