"""Run the bundled websearch skill's real HTTPX regressions in the existing CI suite."""

import os
import subprocess
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parents[2]
SKILL_SOURCE = REPO / "skills" / "websearch" / "src"
SKILL_TESTS = REPO / "skills" / "websearch" / "test"


class WebsearchResponseBoundsTests(unittest.TestCase):
    def test_real_httpx_response_bounds(self):
        env = os.environ.copy()
        env["PYTHONPATH"] = str(SKILL_SOURCE)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        result = subprocess.run(
            [
                "uv",
                "run",
                "--no-project",
                "--python",
                "3.11",
                "--with",
                "httpx>=0.27,<1",
                "--with",
                "pytest>=7,<9",
                "python",
                "-B",
                "-m",
                "pytest",
                "-q",
                "-p",
                "no:cacheprovider",
                str(SKILL_TESTS),
            ],
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
