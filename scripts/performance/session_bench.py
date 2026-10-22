#!/usr/bin/env python3
"""Compare release binaries through pa-perf's product-owned corpus and PTY driver."""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import re
import subprocess

from provenance import file_sha256, harness_sha256


def measure(driver: Path, binary: Path, runtime: Path, package: Path,
            profile: str, evidence: Path) -> dict:
    # Only a reviewed driver and candidate code inside workload confinement run here.
    env = {key: os.environ[key] for key in ('PATH', 'HOME', 'TMPDIR') if key in os.environ}
    env.update(PI_PACKAGE_DIR=str(package), PRIME_AGENT_KERNEL_PYTHON=str(runtime),
               UV_OFFLINE='1', DO_NOT_TRACK='1')
    with evidence.with_suffix('.log').open('wb') as log:
        subprocess.run([str(driver), 'run', '--binary', str(binary), '--profile', profile,
                        '--runs', '1', '--out', str(evidence)], env=env,
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    metrics = {}
    results = sorted((evidence / 'results').glob('*.json'))
    if not results:
        raise ValueError('pa-perf produced no scenario results')
    unavailable = []
    for path in results:
        row = json.loads(path.read_text())
        scenario = row['scenario']
        samples = row['samples_ms']
        if len(samples) != 1 or scenario + '_ms' in metrics:
            raise ValueError('unexpected pa-perf scenario samples')
        if not isinstance(samples[0], (int, float)) or not math.isfinite(samples[0]) or samples[0] < 0:
            raise ValueError('invalid pa-perf latency sample')
        metrics[scenario + '_ms'] = samples[0]
        rss = row.get('samples_rss_bytes')
        if rss is None:
            unavailable.append(scenario)
        elif len(rss) != 1:
            raise ValueError('unexpected pa-perf RSS samples')
        else:
            if not isinstance(rss[0], int) or rss[0] < 0:
                raise ValueError('invalid pa-perf RSS sample')
            metrics[scenario + '_rss_bytes'] = rss[0]
    return {'metrics': metrics, 'rss_unavailable': unavailable}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--driver', type=Path, required=True)
    for side in ('base', 'head'):
        for name in ('bin', 'runtime', 'package'):
            parser.add_argument(f'--{side}-{name}', type=Path, required=True)
        parser.add_argument(f'--{side}-sha', required=True)
        parser.add_argument(f'--{side}-runtime-manifest', type=Path)
    parser.add_argument('--profile', action='append', choices=('small', 'medium', 'large', 'xl'))
    parser.add_argument('--trials', type=int, default=10)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if not 1 <= args.trials <= 30:
        parser.error('requires 1..30 trials')
    if not all(re.fullmatch('[0-9a-f]{40}', sha) for sha in (args.base_sha, args.head_sha)):
        parser.error('requires full lowercase commit SHAs')
    profiles = list(dict.fromkeys(args.profile or ['small']))
    args.out.mkdir(parents=True, exist_ok=False)
    report = {'schema': 1, 'status': 'failed', 'base_sha': args.base_sha, 'head_sha': args.head_sha,
              'trials': args.trials, 'harness_sha256': harness_sha256(),
              'driver_sha256': file_sha256(args.driver), 'sides': {}}
    for side in ('base', 'head'):
        manifest = getattr(args, f'{side}_runtime_manifest')
        report['sides'][side] = {
            'binary_sha256': file_sha256(getattr(args, f'{side}_bin')),
            'runtime_command_sha256': file_sha256(getattr(args, f'{side}_runtime')),
            'runtime_manifest_sha256': file_sha256(manifest) if manifest else None,
            'samples': {profile: [] for profile in profiles}}
    try:
        for trial in range(args.trials):
            for side in (('base', 'head') if trial % 2 == 0 else ('head', 'base')):
                for profile in profiles:
                    sample = measure(args.driver.absolute(), getattr(args, f'{side}_bin').absolute(),
                                     getattr(args, f'{side}_runtime').absolute(),
                                     getattr(args, f'{side}_package').absolute(), profile,
                                     args.out / f'{trial}-{side}-{profile}')
                    report['sides'][side]['samples'][profile].append(sample)
                    (args.out / 'report.json').write_text(json.dumps(report, indent=2, allow_nan=False))
        report['status'] = 'completed'
    except Exception:
        report['status'] = 'failed'
        raise
    finally:
        (args.out / 'report.json').write_text(json.dumps(report, indent=2, allow_nan=False))


if __name__ == '__main__':
    main()
