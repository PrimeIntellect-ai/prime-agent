from __future__ import annotations

import os
import sys
import types
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, call, patch

fake_dependency = types.ModuleType("prime_sandboxes")
fake_dependency.APIClient = object
fake_dependency.SandboxClient = object
original_dependency = sys.modules.get("prime_sandboxes")
sys.modules["prime_sandboxes"] = fake_dependency
try:
    import cleanup
finally:
    if original_dependency is None:
        del sys.modules["prime_sandboxes"]
    else:
        sys.modules["prime_sandboxes"] = original_dependency


class CleanupTests(unittest.TestCase):
    def test_cleanup_pages_by_exact_generation_labels_and_deletes_each_sandbox(self):
        first = SimpleNamespace(sandboxes=[SimpleNamespace(id=f"sandbox-{index}") for index in range(50)])
        second = SimpleNamespace(sandboxes=[SimpleNamespace(id="sandbox-50")])
        client = MagicMock()
        client.list.side_effect = [first, second]
        with (
            patch.object(cleanup, "APIClient") as api_client,
            patch.object(cleanup, "SandboxClient", return_value=client) as sandbox_client,
            patch.dict(
                os.environ,
                {"PRIME_SANDBOX_API_KEY": "secret", "PRIME_TEAM_ID": "team-one"},
                clear=False,
            ),
        ):
            count = cleanup.cleanup("owner/repository", 77, 2)

        self.assertEqual(count, 51)
        api_client.assert_called_once_with(api_key="secret")
        sandbox_client.assert_called_once_with(api_client.return_value)
        labels = [
            "prime-agent-behavioral-v1",
            "repository:owner/repository",
            "run:77",
            "attempt:2",
        ]
        self.assertEqual(
            client.list.call_args_list,
            [
                call(
                    team_id="team-one",
                    labels=labels,
                    page=1,
                    per_page=50,
                    exclude_terminated=True,
                ),
                call(
                    team_id="team-one",
                    labels=labels,
                    page=2,
                    per_page=50,
                    exclude_terminated=True,
                ),
            ],
        )
        self.assertEqual(
            client.delete.call_args_list,
            [call(f"sandbox-{index}") for index in range(51)],
        )

    def test_cleanup_rejects_an_invalid_repository_before_creating_a_client(self):
        with (
            patch.object(cleanup, "APIClient") as api_client,
            self.assertRaisesRegex(ValueError, "invalid repository"),
        ):
            cleanup.cleanup("owner/repository/extra", 1, 1)
        api_client.assert_not_called()


if __name__ == "__main__":
    unittest.main()
