"""Focused tests for the hosted launch/wait/collect orchestration."""

import json
import re
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))

from scripts.evals.short_swe import hosted_eval  # noqa: E402


class FakePopen:
    def __init__(self, command, **kwargs):
        self.command = command


def _write_inputs(tmp_path: Path) -> None:
    request = {
        "pr": 2306,
        "head_sha": "c" * 40,
        "base_sha": "b" * 40,
        "repository": "PrimeIntellect-ai/prime-agent",
        "run_id": 7,
    }
    sources = {
        "base": {
            "tarballs_url": "https://example.invalid/base.zip",
            "commit": "b" * 40,
            "checksums": {"prime-agent-0.0.0-benchmark.tgz": "0" * 64},
            "token": "tok",
        },
        "head": {
            "tarballs_url": "https://example.invalid/head.zip",
            "commit": "c" * 40,
            "checksums": {"prime-agent-0.0.0-benchmark.tgz": "1" * 64},
            "token": "tok",
        },
    }
    (tmp_path / "request.json").write_text(json.dumps(request))
    (tmp_path / "sources.json").write_text(json.dumps(sources))


def test_launch_starts_six_evaluations_with_the_manifest_identity(tmp_path: Path, monkeypatch) -> None:
    _write_inputs(tmp_path)
    commands = []
    logs = {}

    def fake_popen(command, **kwargs):
        commands.append(command)
        log = kwargs["stdout"]
        name = command[command.index("--eval-name") + 1]
        logs[name] = log
        log.write(f"Evaluation ID: id-{name}\n")
        log.flush()
        return FakePopen(command)

    monkeypatch.setattr(hosted_eval.subprocess, "Popen", fake_popen)
    monkeypatch.setenv(hosted_eval.JOB_DEADLINE_ENV, str(time.time() + 300 * 60))
    args = type(
        "Args",
        (),
        {
            "request": str(tmp_path / "request.json"),
            "sources": str(tmp_path / "sources.json"),
            "output": str(tmp_path / "hosted"),
            "model": None,
        },
    )()
    hosted_eval.launch(args)

    assert len(commands) == 6
    runs = json.loads((tmp_path / "hosted" / "hosted-runs.json").read_text())
    assert set(runs) == {
        "base/swebench-verified",
        "base/swebench-pro",
        "base/scaleswe",
        "head/swebench-verified",
        "head/swebench-pro",
        "head/scaleswe",
    }
    for command in commands:
        assert command[command.index("-m") + 1] == "internal/glm-5.3-fast"
        assert command[command.index("--max-concurrent") + 1] == "4"
        assert command[command.index("--timeout-minutes") + 1] == str(
            hosted_eval.HOSTED_EVALUATION_TIMEOUT_MINUTES
        )
        assert command[command.index("-r") + 1] == "1"
        secrets = json.loads(command[command.index("--custom-secrets") + 1])
        assert set(secrets) == {
            "CANDIDATE_TARBALLS_URL",
            "CANDIDATE_COMMIT",
            "CANDIDATE_CHECKSUMS",
            "CANDIDATE_TOKEN",
        }
        assert secrets["CANDIDATE_COMMIT"] in ("b" * 40, "c" * 40)
    for record in runs.values():
        assert record["evaluation_id"].startswith("id-")
    for log in logs.values():
        log.close()


def test_launch_rejects_an_unpinned_model(tmp_path: Path, monkeypatch) -> None:
    _write_inputs(tmp_path)
    monkeypatch.setattr(hosted_eval.subprocess, "Popen", lambda *a, **k: None)
    args = type(
        "Args",
        (),
        {
            "request": str(tmp_path / "request.json"),
            "sources": str(tmp_path / "sources.json"),
            "output": str(tmp_path / "hosted"),
            "model": "unrelated/model",
        },
    )()
    try:
        hosted_eval.launch(args)
        raise AssertionError("unpinned model accepted")
    except ValueError as error:
        assert "not pinned" in str(error)


def test_collect_writes_native_episodes(tmp_path: Path, monkeypatch) -> None:
    runs = {
        "base/swebench-verified": {
            "evaluation_id": "id-1",
            "num_examples": 1,
        }
    }
    output = tmp_path / "hosted"
    output.mkdir()
    (output / "hosted-runs.json").write_text(json.dumps(runs))
    sample = {"info": {"native_wrapper": {"id": "episode-1", "traces": []}}}

    def fake_run(command, **kwargs):
        return json.dumps({"samples": [sample]})

    monkeypatch.setattr(hosted_eval, "run", fake_run)
    args = type("Args", (), {"output": str(output)})()
    hosted_eval.collect(args)

    written = (output / "raw-eval" / "base" / "swebench-verified" / "traces.jsonl").read_text()
    assert json.loads(written) == {"id": "episode-1", "traces": []}


def test_collect_bounds_every_call_by_the_collection_reserve(tmp_path: Path, monkeypatch) -> None:
    output = tmp_path / "hosted"
    output.mkdir()
    runs = {
        "base/swebench-verified": {"evaluation_id": "id-1", "num_examples": 1},
        "head/scaleswe": {"evaluation_id": "id-2", "num_examples": 1},
    }
    (output / "hosted-runs.json").write_text(json.dumps(runs))
    sample = {"info": {"native_wrapper": {"id": "episode-1", "traces": []}}}
    timeouts = []

    def fake_run(command, **kwargs):
        timeouts.append(kwargs.get("timeout"))
        return json.dumps({"samples": [sample]})

    monkeypatch.setattr(hosted_eval, "run", fake_run)
    args = type("Args", (), {"output": str(output)})()
    hosted_eval.collect(args)
    assert len(timeouts) == 2
    assert all(value and value <= hosted_eval.COLLECT_RESERVE_MINUTES * 60 for value in timeouts)

    monkeypatch.setattr(hosted_eval, "COLLECT_RESERVE_MINUTES", 0)
    with pytest.raises(RuntimeError, match="exceeded its reserve"):
        hosted_eval.collect(args)


def test_collect_fails_when_a_sample_lacks_the_native_episode(tmp_path: Path, monkeypatch) -> None:
    runs = {"base/swebench-verified": {"evaluation_id": "id-1", "num_examples": 1}}
    output = tmp_path / "hosted"
    output.mkdir()
    (output / "hosted-runs.json").write_text(json.dumps(runs))

    def fake_run(command, **kwargs):
        return json.dumps({"samples": [{"info": {}}]})

    monkeypatch.setattr(hosted_eval, "run", fake_run)
    args = type("Args", (), {"output": str(output)})()
    try:
        hosted_eval.collect(args)
        raise AssertionError("missing native episode accepted")
    except RuntimeError as error:
        assert "native episode record" in str(error)


def test_launch_uses_the_request_pr_key(tmp_path: Path) -> None:
    # ci.py writes the request with a "pr" key; the launch name must use it.
    source = hosted_eval.__file__
    ci = (Path(source).parent / "ci.py").read_text()
    assert '"pr"' in ci
    hosted = Path(source).read_text()
    assert "request['pr']" in hosted
    assert "pull_request'" not in hosted


def test_launch_stops_created_evaluations_when_a_spawn_fails(tmp_path: Path, monkeypatch) -> None:
    _write_inputs(tmp_path)
    stopped = []

    def fake_popen(command, **kwargs):
        if len(stopped) == 2:  # third launch fails after two started
            raise OSError("spawn failed")
        stopped.append(None)
        log = kwargs["stdout"]
        name = command[command.index("--eval-name") + 1]
        log.write(f"Evaluation ID: id-{name}\n")
        log.flush()
        return FakePopen(command)

    def fake_run(command, **kwargs):
        if command[:3] == ["prime", "eval", "stop"]:
            stopped.append(command[3])
        return "{}"

    monkeypatch.setattr(hosted_eval.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(hosted_eval, "run", lambda *a, **k: "{}")
    monkeypatch.setenv(hosted_eval.JOB_DEADLINE_ENV, str(time.time() + 300 * 60))
    monkeypatch.setattr(hosted_eval.subprocess, "run", lambda command, **kwargs: fake_run(command))
    args = type(
        "Args",
        (),
        {
            "request": str(tmp_path / "request.json"),
            "sources": str(tmp_path / "sources.json"),
            "output": str(tmp_path / "hosted"),
            "model": None,
        },
    )()
    try:
        hosted_eval.launch(args)
        raise AssertionError("partial launch did not fail")
    except OSError:
        pass
    # Both already-created evaluations are stopped by ids parsed from their launcher logs.
    assert stopped[:2] == [None, None]
    assert len(stopped) == 4 and all(isinstance(value, str) for value in stopped[2:])


def test_hosted_budgets_fit_the_github_job_limit(monkeypatch) -> None:
    workflow = (ROOT / ".github" / "workflows" / "behavioral-evals.yml").read_text()
    job_limit = int(re.search(r"\n    timeout-minutes: (\d+)", workflow).group(1))
    assert hosted_eval.GITHUB_JOB_LIMIT_MINUTES == job_limit
    assert f"BEHAVIORAL_JOB_DEADLINE_EPOCH=$(( $(date +%s) + {job_limit} * 60 ))" in workflow
    # The per-evaluation cap plus the collection reserve have to fit inside the job limit.
    assert hosted_eval.HOSTED_EVALUATION_TIMEOUT_MINUTES + hosted_eval.COLLECT_RESERVE_MINUTES <= job_limit
    budget_minutes = 100
    monkeypatch.setenv(hosted_eval.JOB_DEADLINE_ENV, str(time.time() + budget_minutes * 60 + 1))
    assert hosted_eval.evaluation_timeout_minutes() == budget_minutes - hosted_eval.COLLECT_RESERVE_MINUTES
    remaining = hosted_eval.wait_deadline() - time.time()
    assert 0 < remaining <= (budget_minutes - hosted_eval.COLLECT_RESERVE_MINUTES) * 60 + 1
    monkeypatch.setenv(hosted_eval.JOB_DEADLINE_ENV, str(time.time() - 60))
    with pytest.raises(RuntimeError, match="budget"):
        hosted_eval.evaluation_timeout_minutes()
    monkeypatch.delenv(hosted_eval.JOB_DEADLINE_ENV)
    with pytest.raises(RuntimeError, match=hosted_eval.JOB_DEADLINE_ENV):
        hosted_eval.wait_deadline()


def test_wait_bounds_each_poll_and_stops_runs_when_one_stalls(tmp_path: Path, monkeypatch) -> None:
    output = tmp_path / "hosted"
    output.mkdir()
    runs = {"base/swebench-verified": {"evaluation_id": "id-1"}}
    (output / "hosted-runs.json").write_text(json.dumps(runs))
    timeouts = []

    def fake_run(command, **kwargs):
        timeouts.append(kwargs.get("timeout"))
        return json.dumps({"status": "COMPLETED"})

    args = type("Args", (), {"output": str(output)})()
    monkeypatch.setattr(hosted_eval, "run", fake_run)
    monkeypatch.setenv(hosted_eval.JOB_DEADLINE_ENV, str(time.time() + 120 * 60))
    hosted_eval.wait(args)
    assert timeouts
    assert all(value and 0 < value <= hosted_eval.POLL_TIMEOUT_SECONDS for value in timeouts)

    stopped = []
    monkeypatch.setattr(hosted_eval, "stop_started", lambda records: stopped.append(sorted(records)))

    def stalled_poll(command, **kwargs):
        raise RuntimeError("prime did not answer within 120s")

    monkeypatch.setattr(hosted_eval, "run", stalled_poll)
    with pytest.raises(RuntimeError, match="did not answer"):
        hosted_eval.wait(args)
    assert stopped == [["base/swebench-verified"]]


def test_stop_is_best_effort_and_parses_launcher_logs(tmp_path: Path, monkeypatch) -> None:
    output = tmp_path / "hosted"
    logs = output / "launch-logs"
    logs.mkdir(parents=True)
    log = logs / "base-swebench-verified.log"
    log.write_text("Evaluation ID: id-1\n")
    (output / "hosted-runs.json").write_text(json.dumps({"base/swebench-verified": {"log": str(log)}}))
    stopped = []
    timeouts = []

    def fake_run(command, **kwargs):
        stopped.append(command)
        timeouts.append(kwargs.get("timeout"))

    monkeypatch.setattr(hosted_eval.subprocess, "run", fake_run)
    args = type("Args", (), {"output": str(output)})()
    hosted_eval.stop(args)
    assert stopped == [["prime", "eval", "stop", "id-1"]]
    assert timeouts == [hosted_eval.STOP_TIMEOUT_SECONDS]
    missing = tmp_path / "missing"
    hosted_eval.stop(type("Args", (), {"output": str(missing)})())
    assert stopped == [["prime", "eval", "stop", "id-1"]]

    def hung_run(command, **kwargs):
        raise hosted_eval.subprocess.TimeoutExpired(command, kwargs.get("timeout"))

    monkeypatch.setattr(hosted_eval.subprocess, "run", hung_run)
    hosted_eval.stop(args)
