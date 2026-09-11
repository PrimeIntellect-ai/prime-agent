from __future__ import annotations

import hashlib
import json
import os
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from typing import get_args
from unittest.mock import patch

import ui
from report import UI_METRICS, render
from schema import UI_METRIC_KEYS, Config, Metric, Observation, ProcessMemory, Report, Side
from ui import (
    fixture_spec,
    session_id,
    session_name,
    spawn_ledger_path,
    tail_marker,
    total_cpu,
    wait_for_roster,
    write_fixtures,
)


def small_fixture(**overrides):
    """Fixture generation with tiny counts so tests stay fast."""
    constants = {
        "MEDIUM_COUNT": 3,
        "MEDIUM_MESSAGES": 2,
        "LARGE_COUNT": 2,
        "LARGE_MESSAGES": 3,
        "HUGE_MESSAGES": 4,
        "FANOUT_COUNT": 2,
        "FANOUT_MESSAGES": 2,
        "SUBAGENT_DEPTH": 4,
        "SUBAGENT_MESSAGES": 2,
    }
    constants.update(overrides)
    return [patch(f"ui.{name}", value) for name, value in constants.items()]


class FixtureTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.agent_dir = self.root / "agent"
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.spec: object = None

    def small_fixture(self, **overrides) -> None:
        for patcher in small_fixture(**overrides):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.spec = fixture_spec()

    def write(self):
        write_fixtures(self.agent_dir, self.workspace, self.spec)
        return self.agent_dir / "sessions"

    def test_ids_and_names_are_deterministic(self):
        self.assertEqual(session_id("large", 1), session_id("large", 1))
        self.assertEqual(session_id("sub", 6), fixture_spec().subagents[5])
        self.assertNotEqual(session_id("large", 1), session_id("large", 2))
        self.assertEqual(session_name("large", 1), "ui-bench-large-01")
        self.assertEqual(tail_marker("sub", 6), "ui-bench-tail-sub-06")

    def test_write_fixtures_regenerates_identical_files_and_clears_stale_state(self):
        self.small_fixture()
        sessions = self.write()
        first = {path.name: path.read_bytes() for path in sorted(self.agent_dir.rglob("*")) if path.is_file()}
        stale = sessions / "stale.jsonl"
        stale.write_text("stale")
        (self.agent_dir / "session-artifacts").mkdir(parents=True)
        (self.agent_dir / "session-artifacts" / "leftover.json").write_text("{}")
        (self.agent_dir / "session-leases").mkdir(parents=True)
        write_fixtures(self.agent_dir, self.workspace, self.spec)
        second = {
            path.name: path.read_bytes() for path in sorted(self.agent_dir.rglob("*")) if path.is_file()
        }
        self.assertEqual(first, second)
        self.assertFalse(stale.exists())
        self.assertFalse((self.agent_dir / "session-artifacts" / "leftover.json").exists())
        expected = ui.LARGE_COUNT + ui.MEDIUM_COUNT + 1 + ui.SUBAGENT_DEPTH + ui.FANOUT_COUNT
        self.assertEqual(len(list(sessions.glob("*.jsonl"))), expected)

    def test_session_file_shape_and_tree_linking(self):
        self.small_fixture(LARGE_MESSAGES=4)
        sessions = self.write()
        identifier = self.spec.large[0]
        entries = [json.loads(line) for line in (sessions / f"{identifier}.jsonl").read_text().splitlines()]
        header = entries[0]
        self.assertEqual(header["type"], "session")
        self.assertEqual(header["version"], 3)
        self.assertEqual(header["id"], identifier)
        self.assertEqual(header["cwd"], str(self.workspace))
        self.assertEqual(header["rlmDepth"], 0)
        names = [entry for entry in entries if entry.get("type") == "session_info"]
        self.assertEqual(names[0]["name"], session_name("large", 1))
        previous = None
        for entry in entries[1:]:
            self.assertEqual(entry["parentId"], previous)
            previous = entry["id"]
        assistants = [entry for entry in entries if entry.get("message", {}).get("role") == "assistant"]
        self.assertTrue(any(tail_marker("large", 1) in json.dumps(entry) for entry in assistants[-1:]))
        self.assertGreater(len(entries), ui.LARGE_MESSAGES)

    def test_subagent_chain_depths_and_spawn_ledger(self):
        self.small_fixture()
        sessions = self.write()
        ledger = spawn_ledger_path(self.agent_dir, sessions)
        expected_digest = hashlib.sha256(str(Path(os.path.realpath(sessions))).encode()).hexdigest()[:16]
        self.assertEqual(ledger.name, f"{expected_digest}.jsonl")
        records = [json.loads(line) for line in ledger.read_text().splitlines()]
        self.assertEqual(records[0]["op"], "meta")
        self.assertEqual(records[0]["sessionsDir"], str(Path(os.path.realpath(sessions))))
        spawns = records[1:]
        self.assertEqual(len(spawns), len(self.spec.subagents) + len(self.spec.fanout))
        chain = [record for record in spawns if record["name"].startswith("ui-bench-sub-")]
        self.assertEqual(len(chain), len(self.spec.subagents))
        fanout = [record for record in spawns if record["name"].startswith("ui-bench-fan-")]
        self.assertEqual(len(fanout), len(self.spec.fanout))
        parent = str(sessions / f"{self.spec.root}.jsonl")
        for record in fanout:
            self.assertEqual(record["depth"], 1)
            self.assertEqual(record["parent"], parent)
        for depth, (record, identifier) in enumerate(zip(chain, self.spec.subagents, strict=True), start=1):
            self.assertEqual(record["op"], "spawn")
            self.assertEqual(record["v"], 1)
            self.assertEqual(record["depth"], depth)
            self.assertEqual(record["parent"], parent)
            self.assertEqual(record["child"], str(sessions / f"{identifier}.jsonl"))
            self.assertEqual(record["name"], session_name("sub", depth))
            parent = record["child"]
            header = json.loads((sessions / f"{identifier}.jsonl").read_text().splitlines()[0])
            self.assertEqual(header["rlmDepth"], depth)


class ProbeLogicTests(unittest.TestCase):
    def test_total_cpu_sums_process_tree(self):
        processes = [
            ProcessMemory(pid=1, name="daemon", rss=10, cpu=1.25),
            ProcessMemory(pid=2, name="worker", rss=20, cpu=0.75),
            ProcessMemory(pid=3, name="kernel", rss=30, cpu=2.0),
        ]
        self.assertEqual(total_cpu(processes), 4.0)
        self.assertEqual(total_cpu([]), 0.0)

    def test_wait_for_roster_requires_a_settled_count(self):
        frames = [
            "agents   0 running, 1 idle, 5 inactive",
            "agents   0 running, 1 idle, 40 inactive",
            "agents   0 running, 1 idle, 70 inactive",
            "agents   0 running, 1 idle, 70 inactive",
            "agents   0 running, 1 idle, 70 inactive",
            "agents   0 running, 1 idle, 70 inactive",
        ]
        terminal = FakeTerminal(frames)
        with patch("time.perf_counter", side_effect=[float(i) for i in range(200)]):
            seconds = wait_for_roster(terminal, settle=3.0, timeout=90)
        self.assertGreaterEqual(seconds, 0.0)
        self.assertIn("70 inactive", terminal.display.text())

        with self.assertRaises(TimeoutError):
            wait_for_roster(
                FakeTerminal(["agents   0 running, 1 idle, 1 inactive"] * 8), settle=3.0, timeout=0.05
            )


class FakeDisplay:
    def __init__(self, text: str = ""):
        self._text = text

    def text(self) -> str:
        return self._text

    def set(self, text: str) -> None:
        self._text = text


class FakeTerminal:
    """Scripted terminal: until() consumes frames, quiet() pumps them one at a time."""

    def __init__(self, frames: list[str]):
        self.display = FakeDisplay(frames[0] if frames else "")
        self.frames = list(frames[1:])
        self.sent: list[str] = []
        self.bytes = 0

    def pump(self) -> bool:
        if not self.frames:
            return False
        self.display.set(self.frames.pop(0))
        self.bytes += len(self.display.text())
        return True

    def until(self, predicate, timeout: float) -> None:  # type: ignore[no-untyped-def]
        while not predicate(self.display):
            if not self.pump():
                raise TimeoutError("Timed out waiting for the expected terminal state")

    def settle(self, seconds: float) -> None:
        while self.pump():
            pass

    def child(self):
        raise NotImplementedError


class SchemaTests(unittest.TestCase):
    def test_ui_metric_keys_match_report_definitions_and_metric_literal(self):
        self.assertEqual(UI_METRIC_KEYS, {definition.key for definition in UI_METRICS})
        for definition in UI_METRICS:
            self.assertIn(definition.key, get_args(Metric))

    def test_config_accepts_and_defaults_ui_trials(self):
        config = Config.load()
        self.assertEqual(config.ui_trials, 3)
        raw = json.loads(Path(__file__).resolve().parents[1].joinpath("config.json").read_text())
        self.assertIn("ui_trials", raw)

    def test_report_validator_uses_ui_trial_counts(self):
        started = datetime(2026, 9, 9, tzinfo=UTC)
        config = Config.load()
        report = Report(
            repository="PrimeIntellect-ai/prime-agent",
            head_repository="PrimeIntellect-ai/prime-agent",
            pr=42,
            run_id=100,
            harness_sha="a" * 40,
            base_sha="a" * 40,
            head_sha="b" * 40,
            started_at=started,
            config=config,
            main=Side(sha="a" * 40),
            pr_head=Side(sha="b" * 40),
        )
        for side in (report.main, report.pr_head):
            for definition in UI_METRICS:
                side.metrics[definition.key] = [
                    Observation(trial=trial, value=1.0) for trial in range(config.ui_trials)
                ]
        report.model_validate(report.model_dump())

        overflowing = report.pr_head.model_copy(deep=True)
        overflowing.metrics["ui_rss"].append(Observation(trial=config.ui_trials, value=1.0))
        with self.assertRaises(ValueError):
            Report.model_validate({**report.model_dump(), "pr_head": overflowing.model_dump()})

    def test_render_includes_ui_section(self):
        started = datetime(2026, 9, 9, tzinfo=UTC)
        config = Config.load()
        report = Report(
            repository="PrimeIntellect-ai/prime-agent",
            head_repository="PrimeIntellect-ai/prime-agent",
            pr=42,
            run_id=100,
            harness_sha="a" * 40,
            base_sha="a" * 40,
            head_sha="b" * 40,
            started_at=started,
            config=config,
            main=Side(sha="a" * 40),
            pr_head=Side(sha="b" * 40),
        )
        for definition in UI_METRICS:
            report.main.metrics[definition.key] = [
                Observation(trial=trial, value=2.0) for trial in range(config.ui_trials)
            ]
            report.pr_head.metrics[definition.key] = [
                Observation(trial=trial, value=2.0) for trial in range(config.ui_trials)
            ]
        report.status = "completed"
        text = render(report)
        self.assertIn("**UI interactions**", text)
        self.assertIn("Resume large session (cold)", text)
        self.assertIn("Open subagent session at depth 6", text)
        self.assertIn("UI memory after interactions", text)


if __name__ == "__main__":
    unittest.main()
