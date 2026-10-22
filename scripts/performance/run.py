#!/usr/bin/env python3
"""Confined worker: prepared product runtimes, real workloads, A/A and A/B."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import re
import resource
import subprocess
import sys
from calibration import compare
from runtime import inventory


def bench_command(suite: str, head: str, args, runtimes: dict, profiles: list[str]) -> list[str]:
    """The argv for one {suite}_bench.py run: A/B when head is 'head', the
    identical-baseline A/A when head is 'base'."""
    head_sha = args.head_sha if head == 'head' else args.base_sha
    command = [sys.executable, str(Path(__file__).with_name(f'{suite}_bench.py')),
               '--base-runtime', str(runtimes['base']), '--head-runtime', str(runtimes[head]),
               '--base-runtime-manifest', str(args.out / 'base-runtime.json'),
               '--head-runtime-manifest', str(args.out / f'{head}-runtime.json'),
               '--base-sha', args.base_sha, '--head-sha', head_sha,
               '--trials', str(args.trials),
               '--out', str(args.out / f'{suite}-{"comparison" if head == "head" else "calibration"}')]
    if suite == 'session':
        command += ['--driver', str(args.driver.absolute()),
                    '--base-bin', str(args.base_bin.absolute()),
                    '--head-bin', str(getattr(args, f'{head}_bin').absolute()),
                    '--base-package', str(args.base_package.absolute()),
                    '--head-package', str(getattr(args, f'{head}_package').absolute())]
        for profile in profiles:
            command += ['--profile', profile]
    return command


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for side in ('base', 'head'):
        parser.add_argument(f'--{side}-sha', required=True)
        parser.add_argument(f'--{side}-runtime', type=Path, required=True)
        parser.add_argument(f'--{side}-bin', type=Path)
        parser.add_argument(f'--{side}-package', type=Path, required=True)
    parser.add_argument('--driver', type=Path)
    parser.add_argument('--suite', choices=('all', 'session', 'kernel'), default='all')
    parser.add_argument('--trials', type=int, default=10)
    parser.add_argument('--profile', action='append', choices=('small', 'medium', 'large', 'xl'))
    parser.add_argument('--test', action='store_true')
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if not all(re.fullmatch('[0-9a-f]{40}', sha) for sha in (args.base_sha, args.head_sha)):
        parser.error('requires full source SHAs')
    if not 1 <= args.trials <= 30:
        parser.error('requires 1..30 trials')
    suites = ('session', 'kernel') if args.suite == 'all' else (args.suite,)
    profiles = list(dict.fromkeys(args.profile or ['small']))
    if 'session' in suites:
        missing = [name for name in ('driver', 'base_bin', 'head_bin',
                                     'base_package', 'head_package') if not getattr(args, name)]
        if missing:
            parser.error('the session suite requires ' + ', '.join('--' + name.replace('_', '-') for name in missing))
    args.out.mkdir(exist_ok=True)
    resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 ** 2, 64 * 1024 ** 2))
    os.environ.update(HOME='/tmp/benchmark-home', UV_OFFLINE='1', PIP_NO_INDEX='1',
                      OPENBLAS_NUM_THREADS='1', OMP_NUM_THREADS='1', MKL_NUM_THREADS='1')
    Path(os.environ['HOME']).mkdir(exist_ok=True)
    worker = {'schema': 1, 'status': 'failed', 'base_sha': args.base_sha,
              'head_sha': args.head_sha,
              'runtime_profile': 'prepared product kernel venvs (--prime-agent-bootstrap)'}
    runtimes = {}
    try:
        for side in ('base', 'head'):
            # Keep the venv path rather than resolving its base-interpreter symlink.
            runtime = getattr(args, f'{side}_runtime').absolute()
            if not runtime.is_file():
                raise ValueError(f'missing prepared runtime: {runtime}')
            runtimes[side] = runtime
            package = getattr(args, f'{side}_package')
            skills = package / 'skills' if package else None
            data = inventory(runtime, skills)
            (args.out / f'{side}-runtime.json').write_text(json.dumps(data, sort_keys=True))
        if args.test:
            subprocess.run([str(runtimes['head']), '-m', 'unittest', 'discover',
                            '-s', str(Path(__file__).parent / 'tests'), '-v'],
                           env={**os.environ, 'PRIME_BENCH_TEST_RUNTIME': str(runtimes['head'])},
                           check=True, timeout=300)
        for suite in suites:
            for head in ('head', 'base'):
                # A/B first, then the identical-baseline A/A that calibrates it.
                subprocess.run(bench_command(suite, head, args, runtimes, profiles), check=True)
            comparison = json.loads((args.out / f'{suite}-comparison' / 'report.json').read_text())
            calibration = json.loads((args.out / f'{suite}-calibration' / 'report.json').read_text())
            summary = compare(comparison, calibration)
            (args.out / f'{suite}-summary.json').write_text(json.dumps(summary, indent=2, allow_nan=False))
        worker['status'] = 'completed'
    finally:
        (args.out / 'worker.json').write_text(json.dumps(worker, indent=2))


if __name__ == '__main__':
    main()
