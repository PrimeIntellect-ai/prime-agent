#!/usr/bin/env python3
"""Confined worker: offline installed runtimes, real workloads and baseline A/A."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import re
import resource
import subprocess
import sys
import tempfile
from runtime import install, inventory


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inputs', type=Path, default=Path('/inputs'))
    parser.add_argument('--out', type=Path, default=Path('/output'))
    parser.add_argument('--base-sha', required=True)
    parser.add_argument('--head-sha', required=True)
    parser.add_argument('--trials', type=int, default=10)
    parser.add_argument('--scenario', action='append', choices=('small', 'large', 'catalog', 'concurrent_large'))
    parser.add_argument('--suite', choices=('all', 'session', 'kernel'), default='all')
    parser.add_argument('--test', action='store_true')
    args = parser.parse_args()
    if not all(re.fullmatch('[0-9a-f]{40}', sha) for sha in (args.base_sha, args.head_sha)):
        parser.error('requires full source SHAs')
    if not 1 <= args.trials <= 30:
        parser.error('requires 1..30 trials')
    args.out.mkdir(exist_ok=True)
    resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 ** 2, 64 * 1024 ** 2))
    os.environ.update(HOME='/tmp/benchmark-home', UV_OFFLINE='1', PIP_NO_INDEX='1',
                      OPENBLAS_NUM_THREADS='1', OMP_NUM_THREADS='1', MKL_NUM_THREADS='1')
    Path(os.environ['HOME']).mkdir(exist_ok=True)
    worker = {'schema': 1, 'status': 'failed', 'base_sha': args.base_sha,
              'head_sha': args.head_sha, 'runtime_profile': 'offline installed bundled packages'}
    try:
        with tempfile.TemporaryDirectory(prefix='pa-runtime-') as temporary:
            runtimes = {}
            for side in ('base', 'head'):
                runtimes[side] = install(args.inputs / side, Path(temporary) / side,
                                         args.out / f'{side}-install.log')
                data = inventory(runtimes[side])
                (args.out / f'{side}-runtime.json').write_text(json.dumps(data, sort_keys=True))
            if args.test:
                subprocess.run([str(runtimes['head']), '-m', 'unittest', 'discover',
                                '-s', str(Path(__file__).parent / 'tests'), '-v'],
                               env={**os.environ, 'PRIME_BENCH_TEST_RUNTIME': str(runtimes['head'])},
                               check=True, timeout=120)
            for suite in ('session', 'kernel'):
                if args.suite not in ('all', suite):
                    continue
                for calibration in (False, True):
                    head = 'base' if calibration else 'head'
                    name = ('kernel-' if suite == 'kernel' else '') + ('calibration' if calibration else 'comparison')
                    command = [sys.executable, str(Path(__file__).with_name(f'{suite}_bench.py')),
                               '--base-runtime', str(runtimes['base']), '--head-runtime', str(runtimes[head]),
                               '--base-runtime-manifest', str(args.out / 'base-runtime.json'),
                               '--head-runtime-manifest', str(args.out / f'{head}-runtime.json'),
                               '--base-sha', args.base_sha, '--head-sha', args.base_sha if calibration else args.head_sha,
                               '--trials', str(args.trials), '--out', str(args.out / name)]
                    if suite == 'session':
                        command += ['--base-bin', str(args.inputs / 'base/prime-agent'),
                                    '--head-bin', str(args.inputs / head / 'prime-agent')]
                        for scenario in args.scenario or []:
                            command += ['--scenario', scenario]
                    subprocess.run(command, check=True, timeout=1500)
            unavailable = [str(log.relative_to(args.out)) for log in args.out.rglob('daemon.log')
                           if 'Python skills unavailable' in log.read_text(errors='replace')]
            if unavailable:
                raise RuntimeError('bundled skills unavailable: ' + ', '.join(unavailable))
            worker['status'] = 'completed'
    finally:
        (args.out / 'worker.json').write_text(json.dumps(worker, indent=2))


if __name__ == '__main__':
    main()
