from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import ci


class ResolveTests(unittest.TestCase):
    def test_request_records_the_trusted_evaluator_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            event = root / "event.json"
            output = root / "request"
            event.write_text(
                json.dumps(
                    {
                        "action": "labeled",
                        "label": {"name": ci.LABEL},
                        "pull_request": {
                            "number": 42,
                            "state": "open",
                            "draft": False,
                            "user": {"login": "contributor"},
                            "labels": [{"name": ci.LABEL}],
                            "base": {
                                "sha": "a" * 40,
                                "repo": {"full_name": "owner/repository"},
                            },
                            "head": {
                                "sha": "b" * 40,
                                "repo": {"full_name": "fork/repository"},
                            },
                        },
                    }
                )
            )
            env = {
                "GITHUB_EVENT_PATH": str(event),
                "GITHUB_REPOSITORY": "owner/repository",
                "GITHUB_RUN_ID": "123",
                "GITHUB_RUN_ATTEMPT": "2",
                "GITHUB_SHA": "c" * 40,
                "GITHUB_OUTPUT": str(root / "outputs"),
            }
            fingerprint = "d" * 64
            with (
                patch.dict(os.environ, env, clear=False),
                patch.object(
                    ci,
                    "evaluator_contract_fingerprint",
                    return_value=fingerprint,
                ),
            ):
                ci.resolve(output, "c" * 40)

            request = json.loads((output / "request.json").read_text())
            self.assertEqual(request["evaluator_contract_fingerprint"], fingerprint)
            self.assertEqual(request["base_sha"], "a" * 40)
            self.assertEqual(request["harness_sha"], "c" * 40)
            outputs = (root / "outputs").read_text()
            self.assertIn("needed=true\n", outputs)
            self.assertIn("approval_required=false\n", outputs)

    def test_synchronize_requires_reapplying_label(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            event = root / "event.json"
            event.write_text(
                json.dumps(
                    {
                        "action": "synchronize",
                        "pull_request": {
                            "number": 42,
                            "state": "open",
                            "draft": False,
                            "user": {"login": "contributor"},
                            "labels": [{"name": ci.LABEL}],
                            "base": {
                                "sha": "a" * 40,
                                "repo": {"full_name": "owner/repository"},
                            },
                            "head": {
                                "sha": "b" * 40,
                                "repo": {"full_name": "fork/repository"},
                            },
                        },
                    }
                )
            )
            outputs = root / "outputs"
            env = {
                "GITHUB_EVENT_PATH": str(event),
                "GITHUB_REPOSITORY": "owner/repository",
                "GITHUB_RUN_ID": "124",
                "GITHUB_RUN_ATTEMPT": "1",
                "GITHUB_SHA": "c" * 40,
                "GITHUB_OUTPUT": str(outputs),
            }
            with patch.dict(os.environ, env, clear=False):
                ci.resolve(root / "request", "c" * 40)
            text = outputs.read_text()
            self.assertIn("needed=false\n", text)
            self.assertIn("approval_required=true\n", text)


if __name__ == "__main__":
    unittest.main()
