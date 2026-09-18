from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tomllib
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))

from scripts.evals.short_swe import (  # noqa: E402
    builder,
    ci,
    cleanup,
    evaluate,
    offline_swebench_grader,
    prepare,
    report,
    verified_verifier,
)

EVAL_ROOT = ROOT / "scripts/evals/short_swe"


def test_workflow_gates_and_revokes_durable_release_status() -> None:
    workflow = (ROOT / ".github/workflows/behavioral-evals.yml").read_text()
    assert "types: [labeled, unlabeled, synchronize, edited, reopened]" in workflow
    assert "push:" in workflow
    assert "github.event.label.name == 'pre-release'" in workflow
    assert "workflow_dispatch" not in workflow
    assert "invalidate-on-pr-change:" in workflow
    assert "invalidate-on-base-change:" in workflow
    assert "Base advanced; reapply pre-release" in workflow
    assert "request.head_sha === pull.head.sha && request.base_sha === pull.base.sha" in workflow
    assert "strict_required_status_checks_policy === true" in workflow
    assert "Behavioral Eval / pre-release approval" in workflow
    assert "[...requiredContexts].every" in workflow
    assert "const strictContexts = new Set(" in workflow
    assert ".filter(rule => rule.type === 'required_status_checks'" in workflow
    assert ".flatMap(rule => rule.parameters.required_status_checks.map" in workflow
    assert "contains(github.event.pull_request.labels.*.name, 'pre-release')" in workflow
    assert "const rules = await github.paginate(" in workflow
    assert "GET /repos/{owner}/{repo}/rules/branches/{branch}" in workflow
    assert workflow.index("Mark the requested head pending") < workflow.index("Check out trusted evaluator")
    assert "Behavioral Eval / pre-release" in workflow
    assert "statuses: write" in workflow
    assert "prime-agent-behavioral-skip-{0}" in workflow


def test_manifest_is_the_fixed_pinned_suite() -> None:
    manifest = json.loads((EVAL_ROOT / "short-swe.json").read_text())
    prepare.validate_manifest(manifest)
    assert {item["id"]: len(item["tasks"]) for item in manifest["tasksets"]} == {
        "swebench-verified": 15,
        "swebench-pro": 8,
        "scaleswe": 5,
    }
    assert manifest["model"] == "internal/glm-5.3-fast"
    assert manifest["autonomous"] is False
    root_concurrency = manifest["max_concurrent"] * 6
    assert manifest["max_concurrent"] == 4
    assert root_concurrency <= 32
    assert manifest["backup_model"] == "internal/deepseek-v4.1-flash"
    tasksets = {item["id"]: item["tasks"] for item in manifest["tasksets"]}
    verified_repositories = {task.rsplit("-", 1)[0] for task in tasksets["swebench-verified"]}
    pro_repositories = {task.removeprefix("instance_").split("-", 1)[0] for task in tasksets["swebench-pro"]}
    assert len(verified_repositories) == 12
    assert len(pro_repositories) == 8


def test_seaborn_parser_ignores_standalone_status_words() -> None:
    config = {
        "instance_id": "mwaskom__seaborn-test",
        "repo": "mwaskom/seaborn",
        "FAIL_TO_PASS": json.dumps(["tests/test_fix.py::test_fixed"]),
        "PASS_TO_PASS": json.dumps(["tests/test_old.py::test_still_works"]),
    }
    log = "FAILED\nPASSED\nPASSED tests/test_fix.py::test_fixed\nPASSED tests/test_old.py::test_still_works\n"
    assert offline_swebench_grader.grade(config, log)[config["instance_id"]]["resolved"] is True
    with pytest.raises(ValueError, match="missing 2 expected"):
        offline_swebench_grader.grade(config, "FAILED\nPASSED\n")


def test_offline_verified_grader_requires_all_expected_tests() -> None:
    config = {
        "instance_id": "astropy__astropy-test",
        "repo": "astropy/astropy",
        "FAIL_TO_PASS": json.dumps(["tests/test_fix.py::test_fixed"]),
        "PASS_TO_PASS": json.dumps(["tests/test_old.py::test_still_works"]),
    }
    passed = "tests/test_fix.py::test_fixed PASSED\ntests/test_old.py::test_still_works PASSED\n"
    report = offline_swebench_grader.grade(config, passed)[config["instance_id"]]
    assert report["resolved"] is True
    with pytest.raises(ValueError, match="missing 1 expected"):
        offline_swebench_grader.grade(config, "tests/test_fix.py::test_fixed PASSED\n")
    forged_append = offline_swebench_grader.grade(
        config,
        "FAILED tests/test_fix.py::test_fixed - assertion\n"
        "PASSED tests/test_fix.py::test_fixed\n"
        "PASSED tests/test_old.py::test_still_works\n",
    )
    assert forged_append[config["instance_id"]]["resolved"] is False
    skipped = offline_swebench_grader.grade(
        config,
        "tests/test_fix.py::test_fixed PASSED\ntests/test_old.py::test_still_works SKIPPED\n",
    )
    assert skipped[config["instance_id"]]["resolved"] is False
    with pytest.raises(ValueError, match="missing 2 expected"):
        offline_swebench_grader.grade(config, "pytest failed before collecting tests")


def test_patch_collection_uses_trusted_base_and_keeps_all_git_states(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
    subprocess.run(["git", "config", "commit.gpgsign", "false"], cwd=repo, check=True)
    for name in ("committed.txt", "staged.txt", "deleted.txt"):
        (repo / name).write_text("base\n")
    (repo / "binary.bin").write_bytes(b"base\x00")
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-qm", "base"], cwd=repo, check=True)
    base = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()

    (repo / "committed.txt").write_text("committed\n")
    subprocess.run(["git", "add", "committed.txt"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-qm", "candidate commit"], cwd=repo, check=True)
    (repo / "staged.txt").write_text("staged\n")
    subprocess.run(["git", "add", "staged.txt"], cwd=repo, check=True)
    (repo / "deleted.txt").unlink()
    (repo / "binary.bin").write_bytes(b"changed\x00binary")
    (repo / "untracked.txt").write_text("untracked\n")

    task = tmp_path / "task/tests"
    task.mkdir(parents=True)
    (task / "config.json").write_text(json.dumps({"base_commit": base}))
    command = verified_verifier.patch_collect_command(task.parent)
    assert command.startswith("rm -rf /logs/artifacts && ")
    subprocess.run(command.split(" && ", 1)[1], cwd=repo, check=True, shell=True)
    patch = Path("/tmp/prime-agent.patch")
    clone = tmp_path / "clone"
    subprocess.run(["git", "clone", "-q", str(repo), str(clone)], check=True)
    subprocess.run(["git", "checkout", "-q", base], cwd=clone, check=True)
    subprocess.run(["git", "apply", "--binary", str(patch)], cwd=clone, check=True)
    assert (clone / "committed.txt").read_text() == "committed\n"
    assert (clone / "staged.txt").read_text() == "staged\n"
    assert not (clone / "deleted.txt").exists()
    assert (clone / "binary.bin").read_bytes() == b"changed\x00binary"
    assert (clone / "untracked.txt").read_text() == "untracked\n"


def test_patch_collection_overrides_candidate_diff_prefix_config(tmp_path: Path) -> None:
    """A candidate that rewrites its repo's diff prefix config must not escape the filter.

    git config diff.srcPrefix/diff.dstPrefix (or diff.mnemonicPrefix) in the solver
    sandbox would make plain git diff emit headers like "diff --git i/... j/...",
    whose sections filter_test_control cannot attribute to a path. The collect
    command must pin the a/ and b/ prefixes itself.
    """
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
    subprocess.run(["git", "config", "commit.gpgsign", "false"], cwd=repo, check=True)
    (repo / "src.py").write_text("x = 1\n")
    tests = repo / "tests"
    tests.mkdir()
    (tests / "test_x.py").write_text("def test_x():\n    assert 1 == 1\n")
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-qm", "base"], cwd=repo, check=True)
    base = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()

    # Candidate tampers with the test and rewrites the diff prefixes it will be
    # collected with.
    (tests / "test_x.py").write_text("def test_x():\n    assert 1 == 2\n")
    (repo / "src.py").write_text("x = 2\n")
    subprocess.run(["git", "config", "diff.srcPrefix", "i/"], cwd=repo, check=True)
    subprocess.run(["git", "config", "diff.dstPrefix", "j/"], cwd=repo, check=True)
    subprocess.run(["git", "config", "diff.mnemonicPrefix", "true"], cwd=repo, check=True)
    subprocess.run(["git", "config", "diff.noprefix", "true"], cwd=repo, check=True)

    task = tmp_path / "task/tests"
    task.mkdir(parents=True)
    (task / "config.json").write_text(json.dumps({"base_commit": base}))
    command = verified_verifier.patch_collect_command(task.parent)
    pins = [
        "-c diff.srcPrefix=a/",
        "-c diff.dstPrefix=b/",
        "-c diff.mnemonicPrefix=false",
        "-c diff.noprefix=false",
    ]
    assert all(pin in command for pin in pins)
    subprocess.run(command.split(" && ", 1)[1], cwd=repo, check=True, shell=True)
    patch = Path("/tmp/prime-agent.patch").read_text()
    assert "diff --git a/tests/test_x.py b/tests/test_x.py" in patch

    filtered = verified_verifier.filter_test_control(patch)
    assert "x = 2" in filtered
    assert "assert 1 == 2" not in filtered


def test_verified_test_rewrite_handles_pinned_install_variants() -> None:
    for install in [*sorted(verified_verifier.INSTALLS), None]:
        script = "\n".join(
            filter(
                None,
                [
                    install,
                    verified_verifier.LOG_ASSIGNMENT,
                    verified_verifier.TEE_REDIRECT,
                    "pytest tests || true",
                    verified_verifier.PARSER,
                ],
            )
        )
        rewritten = verified_verifier.rewrite_test_script(script)
        assert "uv run parser.py" not in rewritten
        assert "TEST_STATUS=$?" in rewritten
        assert 'exit "${TEST_STATUS:-0}"' in rewritten
        assert "/logs/verifier/test.log" not in rewritten
        assert "output captured by the runtime controller" in rewritten
        if install:
            assert "dependencies are pinned in the task image" in rewritten
            assert "pip install" not in rewritten
    source = (EVAL_ROOT / "secure_harbor.py").read_text()
    assert "head -c 16000001" in source
    assert 'runtime.read("/logs/verifier/test.log"' not in source
    assert '["rm", "-f", "/tests/config.json", "/tmp/tests.tgz"]' in source
    with pytest.raises(RuntimeError, match="template"):
        verified_verifier.rewrite_test_script("python -m pip install malicious")


def test_oracle_is_network_blocked_and_required_to_resolve() -> None:
    manifest = json.loads((EVAL_ROOT / "short-swe.json").read_text())
    config = tomllib.loads(prepare.oracle_config_text(manifest))
    assert config["env"]["id"] == "secure_harbor"
    assert config["env"]["agent"]["runtime"]["allow"] == []
    assert config["env"]["verifier"]["runtime"]["allow"] == []
    assert config["env"]["timeout"]["finalize"] == 600
    assert config["env"]["agent"]["timeout"]["scoring"] == 600
    assert config["env"]["taskset"]["tasks"] == ["astropy__astropy-14096"]
    assert config["env"]["agent"]["harness"]["id"] == "oracle_harness"
    trace = fake_trace()
    trace.task.data.name = "swe-bench/astropy__astropy-14096"
    episode = SimpleNamespace(traces=[trace], errors=[])
    evaluate.validate_oracle_episode(episode)
    trace.rewards = {"solved": SimpleNamespace(score=0.0, weight=1.0)}
    trace.reward = 0.0
    with pytest.raises(RuntimeError, match="oracle"):
        evaluate.validate_oracle_episode(episode)


def labeled_event() -> dict:
    return {
        "action": "labeled",
        "label": {"name": "pre-release"},
        "pull_request": {
            "number": 2306,
            "state": "open",
            "base": {"sha": "b" * 40, "repo": {"full_name": "PrimeIntellect-ai/prime-agent"}},
            "head": {"sha": "c" * 40, "repo": {"full_name": "contributor/prime-agent"}},
        },
    }


def test_task_runtime_credentials_are_removed_before_sandbox_creation(tmp_path: Path) -> None:
    harbor = tmp_path / "verifiers/v1/tasksets/harbor/taskset.py"
    harbor.parent.mkdir(parents=True)
    harbor.write_text(
        "    def runtime_env(self) -> dict[str, str]:\n        return resolve_env(self.data.env)\n"
    )
    prepare.strip_task_runtime_credentials(tmp_path)
    namespace = {"resolve_env": lambda env: dict(env)}
    exec("class Task:\n" + harbor.read_text(), namespace)
    task = namespace["Task"]()
    task.data = SimpleNamespace(
        env={
            name: "secret"
            for name in ("PRIME_API_KEY", "PRIME_SANDBOX_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "HF_TOKEN")
        }
        | {"SAFE": "value"}
    )
    assert task.runtime_env() == {"SAFE": "value"}


def test_ci_resolves_only_exact_label(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    event = tmp_path / "event.json"
    event.write_text(json.dumps(labeled_event()))
    monkeypatch.setenv("GITHUB_EVENT_PATH", str(event))
    monkeypatch.setenv("GITHUB_REPOSITORY", "PrimeIntellect-ai/prime-agent")
    monkeypatch.setenv("GITHUB_RUN_ID", "7")
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "2")
    request = ci.resolve(tmp_path / "request", "b" * 40)
    assert request["base_sha"] == "b" * 40
    assert request["head_sha"] == "c" * 40
    with pytest.raises(ValueError, match="identity"):
        ci.resolve(tmp_path / "stale", "a" * 40)
    changed = labeled_event()
    changed["label"]["name"] = "release"
    event.write_text(json.dumps(changed))
    with pytest.raises(ValueError, match="pre-release"):
        ci.resolve(tmp_path / "other", "b" * 40)


def fake_trace(*, ok: bool = True, timeout: bool = False):
    usage = SimpleNamespace(prompt_tokens=11, cached_input_tokens=7, completion_tokens=5)
    phases = {
        name: SimpleNamespace(start=1.0, end=2.0, duration=1.0)
        for name in ("boot", "setup", "agent", "finalize", "scoring")
    }
    error = SimpleNamespace(
        type="HarnessError",
        message="agent timeout: rollout exceeded its 3600s budget",
        status_code=None,
    )
    call = SimpleNamespace(
        error=error if timeout else None,
        node=0,
        usage=usage,
        model="internal/glm-5.3-fast",
    )
    reward = SimpleNamespace(score=1.0, weight=1.0, value=1.0)
    return SimpleNamespace(
        task=SimpleNamespace(data=SimpleNamespace(name="suite/task-1")),
        rewards={"reward": reward},
        reward=1.0,
        ok=ok,
        is_completed=True,
        stop_condition=None,
        errors=[error] if timeout else [],
        calls=[call],
        nodes=[SimpleNamespace(parent=None, sampled=True)],
        usage=usage,
        timing=SimpleNamespace(**phases),
        branches=[],
    )


def test_terminal_5xx_tolerates_retried_rate_limits() -> None:
    outage = SimpleNamespace(type="ProviderError", status_code=503, message="")
    rate_limit = SimpleNamespace(type="ProviderError", status_code=429, message="rate limited")
    trace = fake_trace(ok=False, timeout=True)
    trace.rewards = {}
    trace.reward = 0.0
    trace.errors = [outage]
    trace.calls = [
        SimpleNamespace(error=rate_limit, node=0, usage=None, model="internal/glm-5.3-fast"),
        SimpleNamespace(error=outage, node=0, usage=None, model="internal/glm-5.3-fast"),
    ]
    record = evaluate.trace_record(SimpleNamespace(traces=[trace], errors=[], ok=False), "suite")
    assert record["model_failure"] is True
    trace.calls[0].error = SimpleNamespace(type="ProviderError", status_code=400, message="context limit")
    with pytest.raises(ValueError, match="complete trace or model outcome"):
        evaluate.trace_record(SimpleNamespace(traces=[trace], errors=[], ok=False), "suite")


def test_non_finite_aggregate_reward_fails() -> None:
    trace = fake_trace()
    trace.rewards = {"reward": SimpleNamespace(score=1.0, weight=1.0, value=float("inf"))}
    trace.reward = float("inf")
    with pytest.raises(ValueError, match="aggregate reward"):
        evaluate.trace_record(SimpleNamespace(traces=[trace], errors=[], ok=True), "suite")


def test_trace_record_uses_native_usage_buckets() -> None:
    record = evaluate.trace_record(SimpleNamespace(traces=[fake_trace()], errors=[], ok=True), "suite")
    assert record["resolved"] is True
    assert record["uncached_input_tokens"] == 11
    assert record["cached_input_tokens"] == 7
    assert record["output_tokens"] == 5
    assert record["e2e_seconds"] == 5
    trace = fake_trace()
    trace.info = {"isolated_verifier_seconds": 3.5}
    record = evaluate.trace_record(SimpleNamespace(traces=[trace], errors=[], ok=True), "suite")
    assert record["e2e_seconds"] == 8.5


def test_scored_model_timeout_is_an_outcome_but_incomplete_trace_fails() -> None:
    timeout = fake_trace(ok=False, timeout=True)
    timeout.rewards = {}
    timeout.reward = 0.0
    timeout.calls[0].error = None
    record = evaluate.trace_record(SimpleNamespace(traces=[timeout], errors=[], ok=False), "suite")
    assert record["resolved"] is False
    scored_failure = fake_trace(ok=False, timeout=True)
    scored_failure.calls[0].error = None
    with pytest.raises(ValueError, match="complete trace or model outcome"):
        evaluate.trace_record(SimpleNamespace(traces=[scored_failure], errors=[], ok=False), "suite")
    scored_failure.rewards["partial"] = None
    with pytest.raises(ValueError, match="complete trace or model outcome"):
        evaluate.trace_record(SimpleNamespace(traces=[scored_failure], errors=[], ok=False), "suite")
    provider_failure = fake_trace(ok=False, timeout=True)
    provider_failure.rewards = {}
    provider_failure.reward = 0.0
    provider_failure.errors = []
    provider_error = SimpleNamespace(type="ProviderError", status_code=400, message="context limit")
    provider_failure.calls[0].error = provider_error
    provider_failure.errors = [provider_error]
    assert (
        evaluate.trace_record(SimpleNamespace(traces=[provider_failure], errors=[], ok=False), "suite")[
            "resolved"
        ]
        is False
    )
    transient_provider_failure = fake_trace(ok=False, timeout=True)
    transient_provider_failure.rewards = {}
    transient_error = SimpleNamespace(type="ProviderError", status_code=429, message="rate limit")
    transient_provider_failure.calls[0].error = transient_error
    transient_provider_failure.errors = [transient_error]
    with pytest.raises(ValueError, match="complete trace or model outcome"):
        evaluate.trace_record(
            SimpleNamespace(traces=[transient_provider_failure], errors=[], ok=False), "suite"
        )
    mixed_failure = fake_trace(ok=False, timeout=True)
    mixed_failure.rewards = {}
    mixed_failure.calls[0].error = None
    mixed_failure.errors.insert(0, transient_error)
    with pytest.raises(ValueError, match="complete trace or model outcome"):
        evaluate.trace_record(SimpleNamespace(traces=[mixed_failure], errors=[], ok=False), "suite")
    contaminated_timeout = fake_trace(ok=False, timeout=True)
    contaminated_timeout.rewards = {}
    contaminated_timeout.calls[0].error = transient_error
    with pytest.raises(ValueError, match="complete trace or model outcome"):
        evaluate.trace_record(SimpleNamespace(traces=[contaminated_timeout], errors=[], ok=False), "suite")
    credential_failure = fake_trace(ok=False, timeout=True)
    credential_failure.rewards = {}
    credential_error = SimpleNamespace(type="ProviderError", status_code=401, message="unauthorized")
    credential_failure.calls[0].error = credential_error
    credential_failure.errors = [credential_error]
    with pytest.raises(ValueError, match="complete trace or model outcome"):
        evaluate.trace_record(SimpleNamespace(traces=[credential_failure], errors=[], ok=False), "suite")
    unrelated_terminal = fake_trace(ok=False, timeout=True)
    unrelated_terminal.rewards = {}
    unrelated_terminal.calls[0].error = provider_error
    unrelated_terminal.errors = [SimpleNamespace(type="SandboxError", status_code=None, message="lost")]
    with pytest.raises(ValueError, match="complete trace or model outcome"):
        evaluate.trace_record(SimpleNamespace(traces=[unrelated_terminal], errors=[], ok=False), "suite")
    infrastructure = fake_trace(ok=False)
    infrastructure.rewards = {}
    infrastructure.reward = 0.0
    infrastructure.errors = [SimpleNamespace(type="HarnessError", message="sandbox unavailable")]
    with pytest.raises(ValueError, match="complete trace or model outcome"):
        evaluate.trace_record(SimpleNamespace(traces=[infrastructure], errors=[], ok=False), "suite")
    incomplete = fake_trace()
    incomplete.is_completed = False
    incomplete.ok = False
    with pytest.raises(ValueError, match="complete trace or model outcome"):
        evaluate.trace_record(SimpleNamespace(traces=[incomplete], errors=[], ok=False), "suite")


def test_model_failure_without_reported_usage_records_zero_tokens() -> None:
    failure = fake_trace(ok=False, timeout=True)
    failure.rewards = {}
    failure.reward = 0.0
    failure.usage = None
    provider_error = SimpleNamespace(type="ProviderError", status_code=503, message="connection reset")
    failure.calls[0].error = provider_error
    failure.calls[0].usage = None
    failure.errors = [provider_error]
    record = evaluate.trace_record(SimpleNamespace(traces=[failure], errors=[], ok=False), "suite")
    assert record["model_failure"] is True
    assert (record["uncached_input_tokens"], record["cached_input_tokens"], record["output_tokens"]) == (
        0,
        0,
        0,
    )
    scored = fake_trace()
    scored.usage = None
    scored.calls[0].usage = None
    with pytest.raises(ValueError, match="incomplete provider usage"):
        evaluate.trace_record(SimpleNamespace(traces=[scored], errors=[], ok=True), "suite")


@pytest.mark.parametrize(
    ("start", "end"),
    ((float("nan"), 2.0), (1.0, float("inf")), (3.0, 2.0), (0.0, 2.0)),
)
def test_trace_timing_rejects_nonfinite_reversed_or_partial_spans(start: float, end: float) -> None:
    trace = fake_trace()
    trace.timing.agent.start = start
    trace.timing.agent.end = end
    with pytest.raises(ValueError, match="invalid timing"):
        evaluate.validate_timing(trace)


def test_trace_graph_allows_uncommitted_successful_call() -> None:
    trace = fake_trace()
    trace.calls[0].node = None
    trace.calls[0].error = None
    evaluate.validate_graph(trace)


@pytest.mark.parametrize(
    ("parent", "call_node"),
    ((1, 1), (1, -1), (2, 0)),
)
def test_trace_graph_rejects_invalid_links(parent: int | None, call_node: int) -> None:
    trace = fake_trace()
    trace.nodes[0].parent = parent
    trace.calls[0].node = call_node
    with pytest.raises(ValueError, match="invalid"):
        evaluate.validate_graph(trace)


def tasks(resolved: int, multiplier: int = 1) -> list[dict]:
    rows = []
    names = [("swebench-verified", 15), ("swebench-pro", 8), ("scaleswe", 5)]
    index = 0
    for taskset, count in names:
        for _local in range(count):
            rows.append(
                {
                    "taskset": taskset,
                    "task": f"task-{index}",
                    "resolved": index < resolved,
                    "model_failure": False,
                    "uncached_input_tokens": 100 * multiplier,
                    "cached_input_tokens": 200 * multiplier,
                    "output_tokens": 50 * multiplier,
                    "e2e_seconds": float(10 * multiplier),
                    "model_calls": 2,
                }
            )
            index += 1
    return rows


def request() -> dict:
    return {
        "schema_version": 1,
        "repository": "PrimeIntellect-ai/prime-agent",
        "head_repository": "PrimeIntellect-ai/prime-agent",
        "pr": 2306,
        "run_id": 7,
        "attempt": 1,
        "harness_sha": "a" * 40,
        "base_sha": "b" * 40,
        "head_sha": "c" * 40,
    }


def paired(base_resolved: int = 10, head_resolved: int = 10, head_multiplier: int = 1) -> dict:
    return {
        "schema_version": 1,
        "request": request(),
        "model": "internal/glm-5.3-fast",
        "started_at": 1.0,
        "finished_at": 2.0,
        "sides": {"base": tasks(base_resolved), "head": tasks(head_resolved, head_multiplier)},
    }


def test_report_passes_noise_and_colors_meaningful_token_change() -> None:
    result = paired(head_resolved=11, head_multiplier=2)
    markdown, verdict = report.render(result, request())
    assert verdict == "pass"
    assert "\\textcolor" in markdown
    assert "#e5484d" in markdown
    assert "SWE-bench Verified" in markdown
    assert "Cumulative task time | 280.0 s | 560.0 s" in markdown
    assert "concurrent tasks overlap in wall-clock time" in markdown
    assert "End-to-end time" not in markdown
    invalid = paired()
    invalid["sides"]["head"][0]["e2e_seconds"] = -1.0
    with pytest.raises(ValueError, match="e2e_seconds"):
        report.render(invalid, request())
    contradictory = paired(head_resolved=1)
    contradictory["sides"]["head"][0]["model_failure"] = True
    with pytest.raises(ValueError, match="outcome"):
        report.render(contradictory, request())
    assert "task-0" not in markdown


def test_report_fails_drastic_quality_or_efficiency_regression() -> None:
    quality = paired(base_resolved=10, head_resolved=5)
    _, verdict = report.render(quality, request())
    assert verdict == "fail"
    failures = paired()
    for task in failures["sides"]["head"][:3]:
        task["resolved"] = False
        task["model_failure"] = True
    markdown, verdict = report.render(failures, request())
    assert verdict == "fail"
    assert "Model failures increased by 3" in markdown
    assert "#e5484d" in markdown
    efficiency = paired(base_resolved=10, head_resolved=10, head_multiplier=2)
    markdown, verdict = report.render(efficiency, request())
    assert verdict == "fail"
    assert "Cumulative task time reached 2.00x base without more resolutions." in markdown


def _baseline_v2(harness: str, label: str, resolved: int = 0, measured: bool = False) -> dict:
    return {
        "harness": harness,
        "label": label,
        "tasksets": {
            "swebench-verified": {
                "resolved": resolved if measured else 0,
                "tasks": 15,
                "uncached_input_tokens": 100 if measured else 0,
                "cached_input_tokens": 1000 if measured else 0,
                "output_tokens": 10 if measured else 0,
                "measured": measured,
            },
            "swebench-pro": {
                "resolved": resolved if measured else 0,
                "tasks": 8,
                "uncached_input_tokens": 100 if measured else 0,
                "cached_input_tokens": 1000 if measured else 0,
                "output_tokens": 10 if measured else 0,
                "measured": measured,
            },
            "scaleswe": {
                "resolved": resolved if measured else 0,
                "tasks": 5,
                "uncached_input_tokens": 100 if measured else 0,
                "cached_input_tokens": 1000 if measured else 0,
                "output_tokens": 10 if measured else 0,
                "measured": measured,
            },
        },
        "model_failures": 0,
        "e2e_seconds": 100.0 if measured else 0.0,
        "measured_at": "2026-09-18T00:00:00Z" if measured else "1970-01-01T00:00:00Z",
        "source": "test fixture" if measured else "Pending measurement run",
    }


def _baselines_doc(measured_harness: str | None = None) -> dict:
    return {
        "schema_version": 2,
        "description": "Static harness baselines on the 28-task Short SWE suite",
        "model": "internal/glm-5.3-fast",
        "baselines": [
            _baseline_v2(h, label, resolved=3, measured=(h == measured_harness))
            for h, label in report.HARNESS_LABELS.items()
        ],
    }


def test_harness_baselines_file_holds_the_pinned_schema() -> None:
    document = json.loads((EVAL_ROOT / "harness-baselines.json").read_text())
    assert document["schema_version"] == 2
    assert set(b["harness"] for b in document["baselines"]) == set(report.HARNESS_LABELS)
    for entry in document["baselines"]:
        assert set(entry["tasksets"]) == set(report.TASKSET_SIZES)
    validated = report.validate_baselines(document)
    assert set(validated) == set(report.HARNESS_LABELS)


def test_report_renders_the_harness_baselines_section() -> None:
    result = paired(base_resolved=16, head_resolved=18)
    text, verdict = report.render(result, request())
    assert "Harness baselines" in text
    assert verdict == "pass"


def test_unmeasured_baselines_render_placeholders() -> None:
    doc = _baselines_doc(measured_harness=None)
    assert report.validate_baselines(doc)


def test_measured_baselines_render_numbers_and_never_change_the_verdict() -> None:
    doc = _baselines_doc(measured_harness="pi-coding-harness")
    validated = report.validate_baselines(doc)
    assert "pi-coding-harness" in validated
    regression = report.compare(
        {
            "resolved": 10,
            "model_failures": 0,
            "uncached_input_tokens": 100,
            "cached_input_tokens": 1000,
            "output_tokens": 50,
            "e2e_seconds": 10.0,
        },
        {
            "resolved": 1,
            "model_failures": 0,
            "uncached_input_tokens": 100,
            "cached_input_tokens": 1000,
            "output_tokens": 50,
            "e2e_seconds": 10.0,
        },
    )
    assert regression, "regression gates are independent of baselines"


def open_directories(source: Path, destination: Path) -> tuple[int, int]:
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    return os.open(source, flags), os.open(destination, flags)


def test_cleanup_rechecks_labels_paginates_and_attempts_every_delete() -> None:
    labels = ["owner", "repository:repo/name", "run:1", "attempt:1"]
    pages = [
        SimpleNamespace(
            sandboxes=[
                SimpleNamespace(id="owned-1", labels=[*labels, "role:task"]),
                SimpleNamespace(id="foreign", labels=["owner"]),
            ],
            has_next=True,
        ),
        SimpleNamespace(
            sandboxes=[SimpleNamespace(id="owned-2", labels=labels)],
            has_next=False,
        ),
    ]

    class Client:
        def __init__(self):
            self.deleted = []

        def list(self, **kwargs):
            return pages[kwargs["page"] - 1]

        def delete(self, sandbox_id):
            self.deleted.append(sandbox_id)
            if sandbox_id == "owned-1":
                raise RuntimeError("failed")

    client = Client()
    with pytest.raises(RuntimeError, match="1 sandbox"):
        cleanup.cleanup_owned(client, labels)
    assert client.deleted == ["owned-1", "owned-2"]


def test_artifact_snapshot_hashes_one_open_regular_file(tmp_path: Path) -> None:
    source, destination = tmp_path / "source", tmp_path / "destination"
    source.mkdir()
    destination.mkdir()
    original = b"trusted snapshot bytes"
    (source / "artifact.tgz").write_bytes(original)
    source_fd, destination_fd = open_directories(source, destination)
    try:
        record = builder.snapshot_artifact(source_fd, destination_fd, "artifact.tgz")
    finally:
        os.close(source_fd)
        os.close(destination_fd)
    (source / "artifact.tgz").write_bytes(b"replacement")
    assert (destination / "artifact.tgz").read_bytes() == original
    assert record == {
        "name": "artifact.tgz",
        "size": len(original),
        "sha256": hashlib.sha256(original).hexdigest(),
    }


def test_artifact_snapshot_rejects_symlink_fifo_and_oversize(tmp_path: Path) -> None:
    source, destination = tmp_path / "source", tmp_path / "destination"
    source.mkdir()
    destination.mkdir()
    (source / "regular").write_bytes(b"data")
    (source / "symlink.tgz").symlink_to("regular")
    os.mkfifo(source / "fifo.tgz")
    with (source / "large.tgz").open("wb") as stream:
        stream.truncate(builder.MAX_ARTIFACT_BYTES + 1)
    source_fd, destination_fd = open_directories(source, destination)
    try:
        for name in ("symlink.tgz", "fifo.tgz", "large.tgz"):
            with pytest.raises(ValueError):
                builder.snapshot_artifact(source_fd, destination_fd, name)
    finally:
        os.close(source_fd)
        os.close(destination_fd)
    assert list(destination.iterdir()) == []


def test_artifact_directory_rejects_intermediate_symlink(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source, outside = tmp_path / "source", tmp_path / "outside"
    source.mkdir()
    outside.mkdir()
    (outside / "artifacts").mkdir()
    (source / "linked").symlink_to(outside, target_is_directory=True)
    monkeypatch.setattr(builder, "SOURCE", source)
    monkeypatch.setattr(builder, "ARTIFACT_RELATIVE", Path("linked/artifacts"))
    with pytest.raises(OSError):
        builder.open_candidate_artifacts()


def test_compare_gates_positive_totals_over_a_zero_base() -> None:
    base = {
        "resolved": 5,
        "model_failures": 0,
        "uncached_input_tokens": 1,
        "cached_input_tokens": 1,
        "output_tokens": 0,
        "e2e_seconds": 0.0,
    }
    head = {
        "resolved": 5,
        "model_failures": 0,
        "uncached_input_tokens": 1,
        "cached_input_tokens": 1,
        "output_tokens": 100,
        "e2e_seconds": 10.0,
    }
    findings = report.compare(base, head)
    assert findings, "positive totals over a zero base must gate"


# --- filter_test_control tests ---


class TestFilterTestControl:
    """Execution tests for the candidate patch filter."""

    def _diff(self, a: str, b: str) -> str:
        return (
            f"diff --git a/{a} b/{b}\n"
            f"index 1234567..89abcde 100644\n"
            f"--- a/{a}\n"
            f"+++ b/{b}\n"
            f"@@ -1 +1 @@\n+x = 1\n"
        )

    @pytest.mark.parametrize(
        "a,b,kept",
        [
            ("src/module.py", "src/module.py", True),
            ("tests/conftest.py", "tests/helpers.py", False),
            ("src/util.py", "tests/conftest.py", False),
            ("src/none.py", "tests/conftest.py", False),
            ("pyproject.toml", "pyproject.toml", False),
            ("tests/test_foo.py", "tests/test_foo.py", False),
            ("tests/helpers.py", "tests/helpers.py", False),
            ("src/mod.py", "tests/__init__.py", False),
            ("pkg/tests/fixture.py", "pkg/tests/fixture.py", False),
        ],
    )
    def test_filter_paths(self, a: str, b: str, kept: bool) -> None:
        from scripts.evals.short_swe.verified_verifier import filter_test_control

        result = filter_test_control(self._diff(a, b))
        assert bool(result) == kept

    def test_bytes_and_str_match(self) -> None:
        from scripts.evals.short_swe.verified_verifier import filter_test_control

        patch = self._diff("src/lib.py", "src/lib.py")
        assert filter_test_control(patch) == filter_test_control(patch.encode())

    def test_headerless_rejected_and_oversize_capped(self) -> None:
        from scripts.evals.short_swe.verified_verifier import MAX_PATCH_BYTES, filter_test_control

        with pytest.raises(RuntimeError, match="no diff --git header"):
            filter_test_control("--- a/x\n+++ b/x\n@@ -1 +1 @@\n+x\n")
        with pytest.raises(RuntimeError, match="exceeds"):
            filter_test_control(b"x" * (MAX_PATCH_BYTES + 1))

    def test_unattributable_header_rejected(self) -> None:
        """Headers without both a/ and b/ tokens fail closed instead of being kept.

        git config diff.srcPrefix/diff.dstPrefix can produce these; keeping the
        section (as an older version of the filter did) would smuggle test-control
        edits into the verifier.
        """
        from scripts.evals.short_swe.verified_verifier import filter_test_control

        for header in (
            "diff --git i/tests/conftest.py j/tests/conftest.py\n",
            "diff --git a/tests/conftest.py j/tests/conftest.py\n",
            "diff --git i/tests/conftest.py b/tests/conftest.py\n",
            "diff --git tests/conftest.py tests/conftest.py\n",
        ):
            patch = header + (
                "index 1234567..89abcde 100644\n"
                "--- i/tests/conftest.py\n"
                "+++ j/tests/conftest.py\n"
                "@@ -1 +1 @@\n"
                "+assert True\n"
            )
            with pytest.raises(RuntimeError, match="no a/ or b/ path"):
                filter_test_control(patch)

    def test_empty_and_multi_file(self) -> None:
        from scripts.evals.short_swe.verified_verifier import filter_test_control

        assert filter_test_control(b"") == ""
        mixed = self._diff("src/lib.py", "src/lib.py") + self._diff("s.py", "tests/conftest.py")
        result = filter_test_control(mixed)
        assert "src/lib.py" in result and "conftest" not in result
