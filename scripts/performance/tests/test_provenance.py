from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import provenance


class ProvenanceTests(unittest.TestCase):
    def test_helper_change_or_addition_invalidates_harness_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ('provenance.py', 'helper.py'):
                (root / name).write_text('original')
            with patch('provenance.__file__', str(root / 'provenance.py')):
                original = provenance.harness_sha256()
                (root / 'helper.py').write_text('changed helper')
                helper_changed = provenance.harness_sha256()
                (root / 'new_helper.py').write_text('new helper')
                helper_added = provenance.harness_sha256()
            self.assertEqual(len({original, helper_changed, helper_added}), 3)


if __name__ == '__main__':
    unittest.main()
