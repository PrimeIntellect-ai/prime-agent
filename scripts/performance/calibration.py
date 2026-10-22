"""Describe paired deltas only when the identical-baseline calibration is stable."""
from __future__ import annotations

import math
from statistics import median

NOISE_LIMIT = .10
MIN_SAMPLES = 5


def statistics(values: list[float]) -> dict:
    if not values or any(not math.isfinite(value) or value < 0 for value in values):
        raise ValueError('requires finite nonnegative measurements')
    center = median(values)
    mad = median([abs(value - center) for value in values])
    return {'count': len(values), 'median': center, 'mad': mad,
            'relative_mad': mad / center if center else None}


def compare(comparison: dict, calibration: dict) -> dict:
    if (comparison.get('status') != 'completed' or calibration.get('status') != 'completed'
            or calibration['base_sha'] != calibration['head_sha']
            or comparison['base_sha'] != calibration['base_sha']
            or comparison['harness_sha256'] != calibration['harness_sha256']
            or comparison.get('driver_sha256') != calibration.get('driver_sha256')):
        raise ValueError('requires completed matching A/B and identical-baseline A/A evidence')
    identity = comparison['sides']['base']
    for side in ('base', 'head'):
        for field in ('binary_sha256', 'runtime_command_sha256', 'runtime_manifest_sha256'):
            if identity.get(field) != calibration['sides'][side].get(field):
                raise ValueError('calibration does not use the comparison baseline identity')
    scenarios = set(comparison['sides']['base']['samples'])
    if not scenarios or any(set(report['sides'][side]['samples']) != scenarios
                            for report in (comparison, calibration) for side in ('base', 'head')):
        raise ValueError('incomplete scenario evidence')
    rows = []
    # Require complete metric sets on both sides and all trials, not a favorable subset.
    for scenario, samples in comparison['sides']['base']['samples'].items():
        head = comparison['sides']['head']['samples'][scenario]
        baseline_a = calibration['sides']['base']['samples'][scenario]
        baseline_b = calibration['sides']['head']['samples'][scenario]
        if not (len(samples) == len(head) == len(baseline_a) == len(baseline_b)):
            raise ValueError('incomplete trial evidence')
        all_samples = [*samples, *head, *baseline_a, *baseline_b]
        keys = set(samples[0]['metrics']) if samples else set()
        if not keys or any(set(sample['metrics']) != keys for sample in all_samples):
            raise ValueError('incomplete metric evidence')
        for metric in sorted(keys):
            groups = [statistics([sample['metrics'][metric] for sample in group])
                      for group in (samples, head, baseline_a, baseline_b)]
            base, candidate, aa, ab = groups
            aa_drift = abs(ab['median'] - aa['median']) / aa['median'] if aa['median'] else None
            reasons = []
            if min(group['count'] for group in groups) < MIN_SAMPLES:
                reasons.append('insufficient_samples')
            if aa_drift is None or aa_drift > NOISE_LIMIT:
                reasons.append('calibration_drift')
            if any(group['relative_mad'] is None or group['relative_mad'] > NOISE_LIMIT for group in groups):
                reasons.append('noisy_samples')
            rows.append({'scenario': scenario, 'metric': metric,
                         'base': base, 'head': candidate, 'calibration': [aa, ab],
                         'calibration_drift': aa_drift,
                         'delta': (candidate['median'] - base['median']) / base['median'] if base['median'] else None,
                         'label': 'inconclusive' if reasons else 'measured', 'reasons': reasons})
    return {'schema': 1, 'noise_limit': NOISE_LIMIT, 'minimum_samples': MIN_SAMPLES,
            'rows': rows, 'status': 'inconclusive' if any(row['reasons'] for row in rows) else 'measured'}
