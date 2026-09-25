import unittest

from budget import allocate


class AllocateTests(unittest.TestCase):
    def test_shares_sum_exactly_to_income(self):
        shares = allocate(100_00, {"alpha": 1, "beta": 1, "gamma": 1})
        self.assertEqual(sum(shares.values()), 100_00)

    def test_rejects_empty_weights(self):
        with self.assertRaises(ValueError):
            allocate(100_00, {})

    def test_rejects_zero_total_weight(self):
        with self.assertRaises(ValueError):
            allocate(100_00, {"alpha": 0, "beta": 0})

    def test_proportional_shares_for_exact_division(self):
        shares = allocate(200_00, {"alpha": 3, "beta": 1})
        self.assertEqual(shares, {"alpha": 150_00, "beta": 50_00})


if __name__ == "__main__":
    unittest.main()
