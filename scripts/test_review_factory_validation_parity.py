import copy
import unittest
from review_factory_validation_parity import validate


class FactoryValidationGuards(unittest.TestCase):
    def value(self):
        return [
            {'case': 'positive', 'stored': False, 'error': 'resident node watcher cannot declare retries'},
            {'case': 'zero', 'stored': True},
            {'case': 'malformed', 'stored': False, 'error': 'node watcher retries must be an integer between 0 and 10'}]

    def test_rejects_acceptance_or_storage_of_invalid_specs(self):
        validate(self.value())
        for index in (0, 2):
            value = self.value()
            value[index]['stored'] = True
            with self.assertRaises(AssertionError):
                validate(value)
        value = self.value()
        value[1]['stored'] = False
        with self.assertRaises(AssertionError):
            validate(value)

    def test_requires_correct_diagnostic_and_all_cases(self):
        for index in (0, 2):
            value = self.value()
            value[index]['error'] = 'unrelated failure'
            with self.assertRaises(AssertionError):
                validate(value)
        with self.assertRaises(AssertionError):
            validate(self.value()[:-1])


if __name__ == '__main__':
    unittest.main()
