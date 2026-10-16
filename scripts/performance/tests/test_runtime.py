import errno
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runtime import MODULES, SKILLS, install, inventory, wait_listener


class RuntimeTests(unittest.TestCase):
    def test_bound_socket_does_not_count_until_listening(self):
        with tempfile.TemporaryDirectory(prefix='pa-listen-', dir='/tmp') as directory:
            path = str(Path(directory) / 'daemon.sock')
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                server.bind(path)
                listening = threading.Event()
                process = Mock()
                process.poll.return_value = None
                # The first failed connect is observable through the retry hook.
                # Listening starts only then; no timing sleeps or races are needed.
                def start_listening(_seconds):
                    self.assertFalse(listening.is_set())
                    server.listen(1)
                    listening.set()
                with patch('runtime.time.sleep', side_effect=start_listening) as retry:
                    wait_listener(path, process, seconds=2)
                self.assertTrue(listening.is_set())
                self.assertEqual(retry.call_count, 1)
                self.assertEqual(process.poll.call_count, 2)
                with server.accept()[0]:
                    pass

    def test_listener_rejects_exited_process_and_timeout(self):
        process = Mock()
        process.poll.return_value = 1
        with self.assertRaises(RuntimeError):
            wait_listener('/tmp/no-such-benchmark.sock', process)
        process.poll.return_value = None
        with patch('runtime.time.perf_counter', side_effect=[0, 2]):
            with self.assertRaises(TimeoutError):
                wait_listener('/tmp/no-such-benchmark.sock', process, seconds=1)

    def test_listener_does_not_hide_unexpected_socket_errors(self):
        process = Mock()
        process.poll.return_value = None
        connection = Mock()
        connection.__enter__ = Mock(return_value=connection)
        connection.__exit__ = Mock(return_value=False)
        connection.connect.side_effect = OSError(errno.EACCES, 'denied')
        with patch('runtime.socket.socket', return_value=connection), self.assertRaises(OSError):
            wait_listener('/tmp/test.sock', process)

    def test_offline_install_includes_all_bundled_packages_and_checks_dependencies(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload, environment = root / 'payload', root / 'venv'
            wheel_dir = payload / 'runtime-wheels'
            wheel_dir.mkdir(parents=True)
            packages = [wheel_dir / (name.replace('-', '_') + '-0.1-py3-none-any.whl')
                        for name in ('prime-agent-runtime', *SKILLS)]
            for path in packages:
                path.write_bytes(b'wheel fixture, never executed')
            packages.sort()
            def fake_run(command, **kwargs):
                if command[1:3] == ['-m', 'venv']:
                    site = environment / f'lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages'
                    site.mkdir(parents=True)
                return Mock(returncode=0)
            with patch('runtime.subprocess.run', side_effect=fake_run) as run:
                self.assertEqual(install(payload, environment, root / 'install.log'), environment / 'bin/python')
            commands = [call.args[0] for call in run.call_args_list]
            self.assertEqual(len(commands), 3)
            self.assertIn('--no-index', commands[1])
            self.assertIn('--no-deps', commands[1])
            self.assertEqual(commands[1][-len(packages):], list(map(str, packages)))
            self.assertEqual(commands[2][-1], 'check')

    def test_inventory_hashes_installed_files_and_interpreter(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            site = root / 'lib/python3.12/site-packages'
            site.mkdir(parents=True)
            (site / 'module.py').write_text('fixture')
            (site / 'module.pyc').write_bytes(b'ignored bytecode')
            executable = root / 'python'
            executable.write_bytes(b'fixture interpreter, never run')
            data = {'prefix': str(root), 'executable': str(executable), 'modules': {}, 'packages': []}
            with patch('runtime.subprocess.run', return_value=Mock(stdout=json.dumps(data))) as run:
                result = inventory(executable)
            self.assertEqual(len(result['installed_files']), 1)
            self.assertEqual(len(result['interpreter_sha256']), 64)
            code = run.call_args.args[0][-1]
            self.assertIn('path.relative_to(Path(sys.prefix).resolve())', code)
            for name in MODULES:
                self.assertIn(repr(name), code)

    def test_inventory_rejects_linked_packages(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            site = root / 'site-packages'
            site.mkdir()
            executable = root / 'python'
            executable.write_bytes(b'fixture')
            (site / 'escape.py').symlink_to(executable)
            data = {'prefix': str(root), 'executable': str(executable)}
            with patch('runtime.subprocess.run', return_value=Mock(stdout=json.dumps(data))):
                with self.assertRaises(ValueError):
                    inventory(executable)


if __name__ == '__main__':
    unittest.main()
