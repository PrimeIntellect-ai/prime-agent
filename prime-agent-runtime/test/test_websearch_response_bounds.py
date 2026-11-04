"""Run the bundled websearch skill's real HTTPX regressions in the existing CI suite."""

import os
import subprocess
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parents[2]


class WebsearchResponseBoundsTests(unittest.TestCase):
    def test_real_httpx_response_bounds(self):
        env = os.environ.copy()
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        result = subprocess.run(
            ["make", "websearch-gates"],
            cwd=REPO,
            env=env,
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
