from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import build_controller


class BuildControllerTests(unittest.TestCase):
    def test_build_command_respects_the_production_api_timeout_limit(self):
        self.assertEqual(build_controller.MAX_COMMAND_TIMEOUT_SECONDS, 900)

    def test_builder_sandbox_uses_the_configured_team(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(
                os.environ,
                {"PRIME_SANDBOX_API_KEY": "test-key", "PRIME_TEAM_ID": "team-123"},
            ),
            patch.object(build_controller, "APIClient"),
            patch.object(build_controller, "SandboxClient") as sandbox_client,
        ):
            sandbox_client.return_value.create.side_effect = RuntimeError("stop after request")
            with self.assertRaisesRegex(RuntimeError, "stop after request"):
                build_controller.build(
                    "owner/repository",
                    "fork/repository",
                    "a" * 40,
                    123,
                    2,
                    Path(directory),
                )

        request = sandbox_client.return_value.create.call_args.args[0]
        self.assertEqual(request.team_id, "team-123")


if __name__ == "__main__":
    unittest.main()
