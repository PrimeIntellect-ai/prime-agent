from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import provenance


class ProvenanceTests(unittest.TestCase):
    def test_helper_or_lock_change_invalidates_harness_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ('provenance.py', 'terminal.py', 'requirements.lock', 'bootstrap.lock'):
                (root / name).write_text('original')
            with patch('provenance.__file__', str(root / 'provenance.py')):
                original = provenance.harness_sha256()
                (root / 'terminal.py').write_text('changed helper')
                helper_changed = provenance.harness_sha256()
                (root / 'requirements.lock').write_text('changed lock')
                lock_changed = provenance.harness_sha256()
                (root / 'wheel-build.lock').write_text('new build dependency lock')
                wheel_lock_added = provenance.harness_sha256()
            self.assertEqual(len({original, helper_changed, lock_changed, wheel_lock_added}), 4)


if __name__ == '__main__':
    unittest.main()
