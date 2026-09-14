from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import build_controller


class BuildControllerTests(unittest.TestCase):
    def test_builder_command_uses_the_full_build_budget(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(os.environ, {"PRIME_SANDBOX_API_KEY": "test-key"}),
            patch.object(build_controller, "APIClient"),
            patch.object(build_controller, "SandboxClient") as sandbox_client,
        ):
            client = sandbox_client.return_value
            client.create.return_value.id = "sandbox-id"
            client.get.return_value.status = "RUNNING"
            client.execute_command.side_effect = [
                SimpleNamespace(exit_code=0),
                SimpleNamespace(exit_code=0),
                SimpleNamespace(exit_code=0, stdout="1\n"),
                SimpleNamespace(exit_code=0),
                SimpleNamespace(exit_code=1),
            ]
            with self.assertRaisesRegex(RuntimeError, "candidate release build failed"):
                build_controller.build(
                    "owner/repository",
                    "fork/repository",
                    "a" * 40,
                    123,
                    2,
                    Path(directory),
                )

        builder_call = client.execute_command.call_args_list[1]
        self.assertIn("nohup sh -c", builder_call.args[1])
        self.assertLessEqual(
            max(call.kwargs["timeout"] for call in client.execute_command.call_args_list),
            build_controller.COMMAND_TIMEOUT_LIMIT_SECONDS,
        )
        request = client.create.call_args.args[0]
        self.assertEqual(request.timeout_minutes, 120)

    def test_controller_budget_leaves_time_for_artifact_transfers(self):
        declared_seconds = (
            build_controller.PROVISION_TIMEOUT_SECONDS
            + build_controller.SETUP_TIMEOUT_SECONDS
            + build_controller.CONTROL_COMMAND_TIMEOUT_SECONDS
            + build_controller.MAX_BUILD_SECONDS
            + build_controller.CONTROL_COMMAND_TIMEOUT_SECONDS
            + build_controller.CONTROL_COMMAND_TIMEOUT_SECONDS
        )
        sandbox_seconds = build_controller.BUILD_SANDBOX_TIMEOUT_MINUTES * 60

        self.assertGreaterEqual(sandbox_seconds - declared_seconds, 600)

    def test_builder_deadline_returns_without_an_extra_api_call(self):
        client = Mock()
        client.execute_command.return_value = SimpleNamespace(exit_code=0)
        with (
            patch.object(build_controller.time, "monotonic", side_effect=[0, 4_800]),
            patch.object(build_controller.time, "sleep") as sleep,
        ):
            exit_code = build_controller.run_builder(client, "sandbox-id", "python3 builder.py")

        self.assertEqual(exit_code, 124)
        sleep.assert_not_called()
        self.assertEqual(client.execute_command.call_count, 1)

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
