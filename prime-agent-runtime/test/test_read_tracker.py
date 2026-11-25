from __future__ import annotations

import sysconfig
import tempfile
import unittest
from pathlib import Path

from rlm import _read_tracker as tracker_module


class ReadTrackerTest(unittest.TestCase):
    """The audit hook the kernel installs at boot (``rlm.repl.main``)."""

    def setUp(self) -> None:
        tracker_module.install()
        self.assertTrue(tracker_module.is_installed())

    def test_records_a_read_mode_open(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "note.txt"
            path.write_text("hello", encoding="utf-8")
            self.assertIsNone(tracker_module.last_read(path))
            path.read_text(encoding="utf-8")
            stat = path.stat()
            self.assertEqual(tracker_module.last_read(path), (stat.st_mtime_ns, stat.st_size))

    def test_skips_stdlib_reads(self) -> None:
        stdlib_file = Path(sysconfig.get_paths()["stdlib"]) / "os.py"
        if not stdlib_file.exists():
            self.skipTest("stdlib os.py not on disk")
        stdlib_file.read_text(encoding="utf-8")
        self.assertIsNone(tracker_module.last_read(stdlib_file))


if __name__ == "__main__":
    unittest.main()
