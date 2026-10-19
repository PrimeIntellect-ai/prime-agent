#!/usr/bin/env python3
import subprocess
import tempfile
import unittest
from pathlib import Path
from review_socket_pin_parity import install_launcher
from review_draft_disconnect_parity import env_for


class LauncherExtractionTests(unittest.TestCase):
    def test_real_installer_section_remains_valid_shell(self):
        with tempfile.TemporaryDirectory(prefix='socket-fixture-', dir='/tmp') as temp:
            root = Path(temp)
            fixture = root / 'payload'
            fixture.write_text('#!/bin/sh\nprintf "%s\n" "fixture-payload"\n')
            fixture.chmod(0o755)
            env = env_for(root, 'rust')
            launcher = install_launcher(fixture, root, env)
            result = subprocess.run([str(launcher), '--version'], env=env,
                                    capture_output=True, text=True, timeout=10, check=True)
            self.assertEqual(result.stdout, 'fixture-payload\n')


if __name__ == '__main__':
    unittest.main()
