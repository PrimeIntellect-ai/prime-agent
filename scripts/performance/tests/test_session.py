import hashlib
import json
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from session_bench import main, stop_daemon


class SessionTests(unittest.TestCase):
    def test_duplicate_scenarios_run_once_and_record_each_runtime(self):
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
            args = ['session_bench.py', '--base-bin', sys.executable, '--head-bin', sys.executable,
                    '--base-runtime', str(base), '--head-runtime', str(head),
                    '--base-runtime-manifest', str(manifests[0]), '--head-runtime-manifest', str(manifests[1]),
                    '--base-sha', 'a' * 40, '--head-sha', 'b' * 40, '--trials', '1',
                    '--scenario', 'small', '--scenario', 'small', '--out', str(root / 'out')]
            with patch('sys.argv', args), patch('session_bench.measure', return_value={'metrics': {'fixture': 1}}) as measure:
                main()
            report = json.loads((root / 'out/report.json').read_text())
            self.assertEqual(measure.call_count, 2)
            self.assertEqual(report['status'], 'completed')
            for side, runtime, manifest in zip(('base', 'head'), (base, head), manifests):
                self.assertEqual(report['sides'][side]['runtime_command_sha256'], hashlib.sha256(runtime.read_bytes()).hexdigest())
                self.assertEqual(report['sides'][side]['runtime_manifest_sha256'], hashlib.sha256(manifest.read_bytes()).hexdigest())
                self.assertEqual(len(report['sides'][side]['samples']['small']), 1)

    def test_never_signals_a_reaped_daemon_group(self):
        daemon = Mock(pid=1234, returncode=0)
        with patch('session_bench.os.killpg') as signal_group:
            stop_daemon(daemon)
        signal_group.assert_not_called()
        daemon.wait.assert_not_called()

    def test_kill_only_on_unreaped_timeout_and_then_reap(self):
        for wait_results, expected in (([0], [signal.SIGTERM]),
                                       ([subprocess.TimeoutExpired('fixture', 5), 0], [signal.SIGTERM, signal.SIGKILL])):
            daemon = Mock(pid=1234, returncode=None)
            daemon.wait.side_effect = wait_results
            with patch('session_bench.os.killpg') as signal_group:
                stop_daemon(daemon)
            self.assertEqual([call.args for call in signal_group.call_args_list], [(1234, value) for value in expected])
            self.assertEqual(daemon.wait.call_count, len(wait_results))


if __name__ == '__main__':
    unittest.main()
