import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from calibration import compare, statistics


def report(base, head):
    return {'status': 'completed', 'base_sha': 'a' * 40, 'head_sha': 'a' * 40,
            'harness_sha256': 'h', 'sides': {
                side: {'samples': {'kernel': [{'metrics': {'cell_ms': value}} for value in values]}}
                for side, values in [('base', base), ('head', head)]}}


class CalibrationTests(unittest.TestCase):
    def test_stable_calibration_exposes_delta_without_claiming_regression(self):
        result = compare(report([100] * 10, [125] * 10), report([100] * 10, [100] * 10))
        self.assertEqual(result['status'], 'measured')
        self.assertEqual(result['rows'][0]['delta'], .25)
        self.assertEqual(result['rows'][0]['base'],
                         {'count': 10, 'median': 100, 'mad': 0, 'relative_mad': 0})

    def test_noisy_or_drifting_baseline_is_inconclusive(self):
        for values, reason in [([120] * 10, 'calibration_drift'),
                               ([50, 150] * 5, 'noisy_samples')]:
            result = compare(report([100] * 10, [100] * 10), report([100] * 10, values))
            self.assertEqual(result['status'], 'inconclusive')
            self.assertIn(reason, result['rows'][0]['reasons'])

    def test_small_sample_and_zero_baseline_are_not_passes(self):
        result = compare(report([0], [0]), report([0], [0]))
        self.assertEqual(result['rows'][0]['reasons'],
                         ['insufficient_samples', 'calibration_drift', 'noisy_samples'])

    def test_invalid_or_incomplete_evidence_fails(self):
        for value in [float('nan'), float('inf'), -1]:
            with self.assertRaises(ValueError):
                statistics([value])
        baseline = report([100] * 10, [100] * 10)
        for field, value in [('status', 'failed'), ('head_sha', 'b' * 40),
                             ('base_sha', 'b' * 40), ('harness_sha256', 'other'), ('driver_sha256', 'other')]:
            broken = copy.deepcopy(baseline)
            broken[field] = value
            with self.assertRaises(ValueError):
                compare(baseline, broken)
        broken = copy.deepcopy(baseline)
        broken['sides']['head']['samples']['kernel'][0]['metrics'] = {}
        with self.assertRaises(ValueError):
            compare(broken, baseline)
        for mutation in ('scenario', 'trial'):
            broken = copy.deepcopy(baseline)
            if mutation == 'scenario':
                broken['sides']['head']['samples'] = {}
            else:
                broken['sides']['head']['samples']['kernel'].pop()
            with self.assertRaises(ValueError):
                compare(broken, baseline)


if __name__ == '__main__':
    unittest.main()
