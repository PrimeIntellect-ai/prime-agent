#!/usr/bin/env python3
"""Exercise the release workflow's actual channel-advance comparator."""

from pathlib import Path
import subprocess
import textwrap
import unittest


WORKFLOW = Path(__file__).resolve().parents[2] / '.github/workflows/release.yml'
FUNCTION = textwrap.dedent(
    WORKFLOW.read_text().split('          version_gt() {', 1)[1]
    .split('          publish_pointer_pair()', 1)[0]
)
FUNCTION = 'version_gt() {' + FUNCTION


class ChannelVersionTest(unittest.TestCase):
    def test_channel_version_ordering(self):
        cases = [
            ('v0.9.9-beta.61', 'v0.10.1-beta.2', False),
            ('v0.10.1-beta.2', 'v0.9.9-beta.61', True),
            ('v0.10.0-beta.99', 'v0.10.1-beta.1', False),
            ('v0.10.1-beta.1', 'v0.10.0-beta.99', True),
            ('v1.0.0-beta.1', 'v0.99.99-beta.99', True),
            ('v0.99.99-beta.99', 'v1.0.0-beta.1', False),
            ('v0.10.1-beta.10', 'v0.10.1-beta.2', True),
            ('v0.10.1-beta.2', 'v0.10.1-beta.10', False),
            ('v0.10.1', 'v0.10.1-beta.99', True),
            ('v0.10.1-beta.99', 'v0.10.1', False),
            ('v0.10.1', 'v0.10.1', False),
            ('v0.10.1-beta.2', '0.10.1-beta.2', False),
        ]
        for current, candidate, newer in cases:
            with self.subTest(current=current, candidate=candidate):
                result = subprocess.run(
                    ['bash', '-e', '-c', FUNCTION + '\nversion_gt "$1" "$2"',
                     'channel-version-test', current, candidate],
                    check=False, capture_output=True, text=True,
                )
                self.assertEqual(result.returncode, 0 if newer else 1, result.stderr)


if __name__ == '__main__':
    unittest.main()
