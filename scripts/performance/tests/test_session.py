import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from session_bench import main, measure


class SessionTests(unittest.TestCase):
    def test_duplicate_profiles_run_once_and_record_each_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            base, head = root / 'base-runtime', root / 'head-runtime'
            base.write_bytes(b'base interpreter fixture')
            head.write_bytes(b'head interpreter fixture')
            manifests = []
            for side in ('base', 'head'):
                path = root / (side + '.json')
                path.write_text(json.dumps({'runtime': side}))
                manifests.append(path)
            args = ['session_bench.py', '--driver', sys.executable,
                    '--base-bin', sys.executable, '--head-bin', sys.executable,
                    '--base-runtime', str(base), '--head-runtime', str(head),
                    '--base-package', str(root), '--head-package', str(root),
                    '--base-runtime-manifest', str(manifests[0]), '--head-runtime-manifest', str(manifests[1]),
                    '--base-sha', 'a' * 40, '--head-sha', 'b' * 40, '--trials', '1',
                    '--profile', 'small', '--profile', 'small', '--out', str(root / 'out')]
            with patch('sys.argv', args), patch('session_bench.measure', return_value={'metrics': {'fixture': 1}}) as run:
                main()
            report = json.loads((root / 'out/report.json').read_text())
            self.assertEqual(run.call_count, 2)
            self.assertEqual(report['status'], 'completed')
            for side, runtime, manifest in zip(('base', 'head'), (base, head), manifests):
                self.assertEqual(report['sides'][side]['runtime_command_sha256'], hashlib.sha256(runtime.read_bytes()).hexdigest())
                self.assertEqual(report['sides'][side]['runtime_manifest_sha256'], hashlib.sha256(manifest.read_bytes()).hexdigest())
                self.assertEqual(len(report['sides'][side]['samples']['small']), 1)

    def test_uses_product_driver_and_preserves_latency_and_rss(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence = root / 'evidence'
            def fake_run(command, **kwargs):
                result = evidence / 'results'
                result.mkdir(parents=True)
                (result / 'cold-ready.json').write_text(json.dumps({
                    'scenario': 'cold-ready', 'samples_ms': [12], 'samples_rss_bytes': [4096]}))
                return Mock(returncode=0)
            with patch('session_bench.subprocess.run', side_effect=fake_run) as run:
                result = measure(root / 'pa-perf', root / 'prime-agent', root / 'python', root / 'package',
                                 'small', evidence)
            self.assertEqual(result, {'metrics': {'cold-ready_ms': 12, 'cold-ready_rss_bytes': 4096},
                                      'rss_unavailable': []})
            self.assertEqual(run.call_args.args[0], [str(root / 'pa-perf'), 'run', '--binary', str(root / 'prime-agent'),
                                                   '--profile', 'small', '--runs', '1', '--out', str(evidence)])
            self.assertEqual(run.call_args.kwargs['env']['PI_PACKAGE_DIR'], str(root / 'package'))
            self.assertEqual(run.call_args.kwargs['env']['PRIME_AGENT_KERNEL_PYTHON'], str(root / 'python'))


    def test_invalid_driver_results_fail_before_recording_samples(self):
        for row in (None, {'scenario': 'cold-ready', 'samples_ms': [float('nan')]},
                    {'scenario': 'cold-ready', 'samples_ms': [12], 'samples_rss_bytes': [1, 2]}):
            with self.subTest(row=row), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                evidence = root / 'evidence'
                def fake_run(*_args, **_kwargs):
                    result = evidence / 'results'
                    result.mkdir(parents=True)
                    if row is not None:
                        (result / 'scenario.json').write_text(json.dumps(row))
                with patch('session_bench.subprocess.run', side_effect=fake_run), self.assertRaises(ValueError):
                    measure(root / 'driver', root / 'binary', root / 'python', root / 'package', 'small', evidence)

if __name__ == '__main__':
    unittest.main()
