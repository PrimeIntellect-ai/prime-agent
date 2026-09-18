from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from test_benchmarks import fixture

from controller import Controller


class VmSandboxRequestTests(unittest.TestCase):
    """Sandboxes are VM-only: the create request must never pin a `vm` value."""

    @patch.dict(os.environ, {"PRIME_SANDBOX_API_KEY": "secret-token"})
    def test_create_request_omits_vm(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = Controller(fixture(), Path(directory), live_github=False)
            controller.client = Mock()
            controller.client.create.return_value = SimpleNamespace(id="sandbox-1")
            controller.client.get.return_value = SimpleNamespace(status="RUNNING")
            controller.client.execute_command.return_value = SimpleNamespace(exit_code=0)
            controller.client.get_background_job.return_value = SimpleNamespace(completed=True, exit_code=0)
            controller.start("main")
            request = controller.client.create.call_args[0][0]
            payload = request.model_dump(exclude_none=True)
            self.assertNotIn("vm", payload)
            self.assertTrue(payload["docker_image"])
