import os
from pathlib import Path
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from resources import process_tree_rss


class ResourceTests(unittest.TestCase):
    def test_real_process_tree_excludes_its_parent(self):
        script = "import subprocess,sys; p=subprocess.Popen([sys.executable,'-c','import sys; sys.stdin.read()'],stdin=subprocess.PIPE); print(p.pid,flush=True); sys.stdin.read(); p.stdin.close(); p.wait()"
        process = subprocess.Popen([sys.executable, "-c", script], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, text=True)
        try:
            child = int(process.stdout.readline())
            snapshot = process_tree_rss([process.pid])
            pids = {row["pid"] for row in snapshot["processes"]}
            self.assertEqual(pids, {process.pid, child})
            self.assertNotIn(os.getpid(), pids)
            self.assertGreater(snapshot["rss_bytes"], 0)
        finally:
            process.stdin.close()
            process.wait(timeout=5)
            process.stdout.close()


if __name__ == "__main__":
    unittest.main()
