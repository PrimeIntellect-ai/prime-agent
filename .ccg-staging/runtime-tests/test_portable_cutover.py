import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SOURCE_RUNTIME = Path(__file__).resolve().parents[1] / "runtime"


def run(cli, *args, cwd):
    return subprocess.run(
        [sys.executable, str(cli), *args], cwd=cwd, text=True,
        capture_output=True, check=False,
    )


class PortableCutoverTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.project = Path(self.temp.name) / "portable-project"
        self.project.mkdir()
        self.runtime = self.project / "vendor" / "ccg-runtime"
        shutil.copytree(SOURCE_RUNTIME, self.runtime)
        self.cli = self.runtime / "ccg_runtime" / "cli.py"
        self.config = self.project / "config" / "ccg.json"
        result = self.command("init", "--config", str(self.config))
        self.assertEqual(result.returncode, 0, result.stderr)

    def tearDown(self):
        self.temp.cleanup()

    def command(self, *args):
        return run(self.cli, *args, cwd=self.project)

    def route(self, request, selector="default"):
        return self.command("route", "--config", str(self.config), "--selector", selector,
                            "--request", request)

    def payload(self, result):
        self.assertTrue(result.stdout, result.stderr)
        return json.loads(result.stdout)

    def set_enabled(self, enabled):
        return self.command("set-enabled", "--config", str(self.config), "--enabled", str(enabled).lower())

    def test_default_is_staged_and_disabled_until_atomically_enabled(self):
        disabled = self.payload(self.route("goal-task"))
        self.assertEqual(disabled["code"], "CCG_DISABLED")

        enabled = self.set_enabled(True)
        self.assertEqual(enabled.returncode, 0, enabled.stderr)
        self.assertEqual(list(self.config.parent.glob(f".{self.config.name}.*")), [])
        routed = self.payload(self.route("goal-task"))
        self.assertEqual(routed["route"], "ccg")
        self.assertEqual(routed["request"], "goal-task")
        self.assertEqual([stage["name"] for stage in routed["stages"]],
                         ["admission", "dispatch", "runtime", "terminal"])
        self.assertEqual(routed["stages"][0]["status"], "accepted_staged")
        self.assertEqual(routed["stages"][-1]["status"], "pending")

        disabled_again = self.set_enabled(False)
        self.assertEqual(disabled_again.returncode, 0, disabled_again.stderr)
        self.assertEqual(self.payload(self.route("goal-task"))["code"], "CCG_DISABLED")

    def test_supported_goals_use_one_default_router_and_raw_legacy_is_rejected(self):
        self.assertEqual(self.set_enabled(True).returncode, 0)
        for request in ("goal-task", "goal-dispatch", "goal-execute"):
            routed = self.payload(self.route(request))
            self.assertEqual(routed["route"], "ccg")
            self.assertEqual(routed["request"], request)

        bypass = self.payload(self.route("legacy:goal-task"))
        self.assertEqual(bypass["code"], "RAW_LEGACY_BYPASS_REJECTED")
        unknown_selector = self.payload(self.route("goal-task", selector="legacy"))
        self.assertEqual(unknown_selector["code"], "UNKNOWN_SELECTOR")

    def test_only_explicit_rollback_selector_can_select_legacy_adapter(self):
        rollback = self.payload(self.route("goal-dispatch", selector="rollback"))
        self.assertEqual(rollback["route"], "rollback")
        self.assertEqual(rollback["adapter"], "legacy")
        self.assertEqual(rollback["selector"], "rollback")

    def test_adapters_are_thin_and_portable(self):
        self.assertEqual(self.set_enabled(True).returncode, 0)
        for adapter, request in (("goal-task", "goal-task"), ("dispatch-gates", "goal-dispatch")):
            adapter_path = self.runtime / "adapters" / adapter / "ccg_adapter.py"
            result = subprocess.run([sys.executable, str(adapter_path), "--config", str(self.config), "--request", request],
                                    cwd=self.project, text=True, capture_output=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["route"], "ccg")

    def test_core_has_no_machine_specific_roots(self):
        source = "\n".join(p.read_text() for p in (self.runtime / "ccg_runtime").glob("*.py"))
        for forbidden in ("/Users/", "~/.prime", "~/.codex", "/tmp/"):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
