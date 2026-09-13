from __future__ import annotations

import io
import json
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

import ui
from schema import PHASE_METRICS, UI_METRIC_KEYS, Observation, ProcessMemory, Side
from ui import CatalogClient, check_scheduled_jobs, session_id, spawn_ledger_path, write_catalog_fixtures

HELLO = {
    "type": "daemon_hello",
    "protocol": {"name": "prime-agent.daemon", "version": 7},
    "serverCapabilities": ["heartbeat_catalog"],
}


class CatalogFixtureTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.agent = self.root / "agent"
        for name, value in (("CATALOG_COUNT", 8), ("CATALOG_MESSAGES", 2), ("SCHEDULED_OWNERS", 2)):
            patcher = patch.object(ui, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_sparse_paused_schedules_use_real_artifact_paths_and_ledger_edges(self):
        cold, expected = write_catalog_fixtures(self.agent, self.root)
        transcripts = list(self.agent.rglob("*.jsonl"))
        ledger = spawn_ledger_path(self.agent, self.agent / "sessions")
        self.assertEqual(len(transcripts), ui.CATALOG_COUNT + 1)
        records = [json.loads(line) for line in ledger.read_text().splitlines()]
        self.assertEqual(len(records) - 1, ui.CATALOG_COUNT - 2)
        self.assertNotIn(str(cold), [record.get("child") for record in records])
        entries = [json.loads(line) for line in cold.read_text().splitlines()]
        self.assertEqual(sum(entry["type"] == "message" for entry in entries), 2)
        self.assertEqual(entries[0]["id"], cold.stem)
        artifacts = list(self.agent.rglob("scheduled-jobs.json"))
        self.assertEqual(len(artifacts), ui.SCHEDULED_OWNERS)
        found = set()
        for artifact in artifacts:
            job = json.loads(artifact.read_text())["jobs"][0]
            found.add(job["id"])
            self.assertEqual(job["status"], "paused")
            self.assertNotIn("nextRunAt", job)
            self.assertEqual(job["runCount"], 0)
            path = Path(job["sessionFile"])
            self.assertEqual(
                artifact.parent.resolve(), path.parent.parent / "session-artifacts" / job["sessionId"]
            )
            self.assertIn(str(path), [record.get("child") for record in records])
        self.assertEqual(found, expected)

    def test_regeneration_removes_trial_mutations(self):
        cold, _ = write_catalog_fixtures(self.agent, self.root)
        before = {
            str(p.relative_to(self.agent)): p.read_bytes() for p in self.agent.rglob("*") if p.is_file()
        }
        cold.write_text("mutated")
        (self.agent / "sessions/stale.jsonl").write_text("stale")
        write_catalog_fixtures(self.agent, self.root)
        after = {str(p.relative_to(self.agent)): p.read_bytes() for p in self.agent.rglob("*") if p.is_file()}
        self.assertEqual(before, after)

    def test_job_validation_rejects_fast_but_incomplete_or_changed_results(self):
        write_catalog_fixtures(self.agent, self.root)
        jobs = [json.loads(p.read_text())["jobs"][0] for p in self.agent.rglob("scheduled-jobs.json")]
        data = {
            "heartbeats": [
                {
                    "job": job,
                    "sessionName": ui.session_name("catalog", int(job["id"].split("-")[-1])),
                    "firstMessage": "task",
                }
                for job in jobs
            ]
        }
        expected = {job["id"] for job in jobs}
        check_scheduled_jobs(data, expected)
        for items in ([], [data["heartbeats"][0]] * 2):
            with self.assertRaises(RuntimeError):
                check_scheduled_jobs({"heartbeats": items}, expected)
        data["heartbeats"][0]["sessionName"] = "wrong owner"
        with self.assertRaisesRegex(RuntimeError, "metadata"):
            check_scheduled_jobs(data, expected)
        data["heartbeats"][0]["job"]["status"] = "active"
        with self.assertRaisesRegex(RuntimeError, "paused"):
            check_scheduled_jobs(data, expected)


class CatalogProtocolTests(unittest.TestCase):
    def client(self, *messages):
        stream = io.BytesIO(b"".join((json.dumps(message) + "\n").encode() for message in messages))
        return CatalogClient(Mock(), stream)

    def test_out_of_order_scan_replies_retain_completion_times(self):
        client = self.client(
            HELLO,
            {"type": "response", "id": "scan", "success": True, "data": {"heartbeats": []}},
            {"type": "response", "id": "open", "success": True, "data": {"sessionId": "cold"}},
        )
        with patch("ui.time.perf_counter", side_effect=range(1, 100)):
            opened, completed = client.wait("open")
        self.assertEqual(opened["sessionId"], "cold")
        self.assertEqual(completed, 6)
        data, completed = client.wait("scan")
        self.assertEqual(data, {"heartbeats": []})
        self.assertEqual(completed, 3)

    def test_capability_mismatch_and_failed_scan_are_errors(self):
        for hello in (
            HELLO | {"serverCapabilities": []},
            HELLO | {"protocol": {"name": "prime-agent.daemon", "version": 8}},
        ):
            with self.assertRaisesRegex(RuntimeError, "protocol 7"):
                self.client(hello)
        client = self.client(
            HELLO, {"type": "response", "id": "scan", "success": False, "error": "unreadable"}
        )
        with self.assertRaisesRegex(RuntimeError, "unreadable"):
            client.wait("scan")

    def test_wire_envelope_and_bounded_eof_failure(self):
        client = self.client(HELLO)
        client.send("scan-1", {"type": "heartbeats_list"})
        message = json.loads(client.channel.sendall.call_args.args[0])
        self.assertEqual(message["type"], "command")
        self.assertEqual(message["protocol"], HELLO["protocol"])
        self.assertEqual(message["id"], message["command"]["id"])
        with self.assertRaisesRegex(RuntimeError, "closed"):
            client.wait("scan-1")
        with self.assertRaisesRegex(RuntimeError, "limit"):
            CatalogClient(Mock(), io.BytesIO(b"x" * 2_000_001))

    def test_metrics_are_required_for_trial_completion(self):
        metrics = {
            "scheduled_catalog",
            "scheduled_catalog_cpu",
            "scheduled_catalog_warm",
            "scheduled_catalog_warm_cpu",
            "cold_open_catalog",
            "cold_open_catalog_cpu",
        }
        self.assertTrue(metrics <= UI_METRIC_KEYS)
        self.assertTrue(metrics <= set(PHASE_METRICS["ui"]))
        self.assertNotEqual(session_id("catalog", 0), session_id("catalog", ui.CATALOG_COUNT - 1))


class CatalogTrialTests(unittest.TestCase):
    def test_trial_launches_daemon_and_validates_competing_scans_before_recording(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cold = root / "cold.jsonl"
            terminal = Mock(bytes=0, started=time.perf_counter())
            client = Mock(responses={})
            client.send.side_effect = lambda *args: time.perf_counter()
            jobs = {
                "heartbeats": [
                    {
                        "job": {"id": "catalog-job-1", "status": "paused", "runCount": 0},
                        "sessionName": ui.session_name("catalog", 1),
                        "firstMessage": "task",
                    }
                ]
            }

            def reply(identifier):
                if identifier == "residents":
                    data = {"sessions": []}
                elif identifier == "cold-open":
                    data = {"sessionId": cold.stem, "workerState": "ready", "workerPid": 42}
                else:
                    data = jobs
                return data, time.perf_counter()

            client.wait.side_effect = reply
            with (
                patch("ui.Terminal", return_value=terminal),
                patch("ui.input_ready"),
                patch("ui.type_query"),
                patch("ui.clear_search"),
                patch("ui.expand_subagents"),
                patch("ui.wait_for_roster", return_value=0.1),
                patch("ui.write_fixtures"),
                patch("ui.write_catalog_fixtures", return_value=(cold, {"catalog-job-1"})),
                patch("ui.pwd.getpwnam", return_value=SimpleNamespace(pw_uid=123)),
                patch("ui.process_stats", return_value=[ProcessMemory(pid=1, name="daemon", rss=100)]),
                patch("worker.environment", return_value={}),
                patch("worker.stop_processes") as stop,
                patch("ui.socket.socket", return_value=MagicMock()),
                patch("ui.subprocess.Popen") as launch,
                patch("ui.CatalogClient", return_value=client),
            ):
                for incomplete in (False, True):
                    with self.subTest(incomplete=incomplete):
                        jobs["heartbeats"][0]["firstMessage"] = "" if incomplete else "task"
                        side = Side(sha="a" * 40, metrics={"install": [Observation(trial=0, value=1.0)]})
                        ui.ui_measure(Mock(), side, 2, results=root, homes=root, user="benchmark1")
                        if incomplete:
                            self.assertIsNotNone(side.metrics["scheduled_catalog"][0].error)
                            self.assertNotIn("cold_open_catalog", side.metrics)
                        else:
                            for metric in PHASE_METRICS["ui"]:
                                self.assertIsNone(side.metrics[metric][0].error)
                            self.assertEqual(client.wait.call_args.args, ("scan-2",))
                self.assertEqual(
                    launch.call_args.args[0][-4:],
                    [
                        "--mode",
                        "daemon",
                        "--daemon-socket",
                        "/tmp/prime-catalog-123-2.sock",
                    ],
                )
                launch.return_value.wait.assert_called_with(timeout=10)
                stop.assert_called_with("benchmark1")


if __name__ == "__main__":
    unittest.main()
