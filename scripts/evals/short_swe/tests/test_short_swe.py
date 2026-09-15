from __future__ import annotations

import hashlib
import json
import os
import sys
import tomllib
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))

from scripts.evals.short_swe import (  # noqa: E402
    builder,
    candidate_contract,
    ci,
    cleanup,
    evaluate,
    prepare,
    report,
)

EVAL_ROOT = ROOT / "scripts/evals/short_swe"


def test_workflow_is_only_label_gated() -> None:
    workflow = (ROOT / ".github/workflows/behavioral-evals.yml").read_text()
    assert "types: [labeled]" in workflow
    assert "if: github.event.label.name == 'pre-release'" in workflow
    assert "workflow_dispatch" not in workflow
    assert "synchronize" not in workflow
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


def test_config_pins_candidate_and_limits(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manifest = json.loads((EVAL_ROOT / "short-swe.json").read_text())
    monkeypatch.setenv("GITHUB_REPOSITORY", "PrimeIntellect-ai/prime-agent")
    checksums = {name: "d" * 64 for name in sorted(prepare.CANDIDATE_TARBALLS)}
    text = prepare.config_text(manifest["tasksets"][0], manifest, tmp_path, "a" * 40, checksums)
    assert 'id = "prime-agent-candidate"' in text
    assert f"artifact_dir = {json.dumps(str(tmp_path.resolve()))}" in text
    assert f"commit = {json.dumps('a' * 40)}" in text
    assert "autonomous = false" in text
    assert "checksums = {" in text
    assert set(tomllib.loads(text)["env"]["agent"]["harness"]["checksums"]) == prepare.CANDIDATE_TARBALLS
    assert "max_turns = 128" in text
    assert "max_output_tokens = 100000" in text
    assert "max_total_tokens = 5000000" in text
    assert "rollout = 3600" in text


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
    call = SimpleNamespace(error=error if timeout else None, node=0, usage=usage)
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


def test_candidate_contract_enforces_artifacts_mode_and_credentials(tmp_path: Path) -> None:
    secrets = {name: "secret" for name in candidate_contract.CREDENTIAL_ENV}
    process = candidate_contract.process_env({"SAFE": "value"})
    merged = {**secrets, **process}
    assert merged == {**dict.fromkeys(candidate_contract.CREDENTIAL_ENV, ""), "SAFE": "value"}
    with pytest.raises(ValueError, match="autonomous"):
        candidate_contract.require_non_autonomous(True)

    blobs = {}
    for index, name in enumerate(candidate_contract.TARBALLS):
        blobs[name] = f"tarball-{index}".encode()
        (tmp_path / name).write_bytes(blobs[name])
    checksums = {name: hashlib.sha256(data).hexdigest() for name, data in blobs.items()}
    loaded, computed = candidate_contract.load_artifacts(tmp_path, checksums)
    assert loaded == blobs
    assert computed == checksums
    (tmp_path / candidate_contract.TARBALLS[0]).write_bytes(b"changed")
    with pytest.raises(ValueError, match="checksum mismatch"):
        candidate_contract.load_artifacts(tmp_path, checksums)

    source = (EVAL_ROOT / "prime_agent_candidate.py").read_text()
    assert source.count("process_env(") == 2
    assert "curl" not in source
    assert "sha256sum -c" in source


def test_trace_record_uses_native_usage_buckets() -> None:
    record = evaluate.trace_record(SimpleNamespace(traces=[fake_trace()], errors=[], ok=True), "suite")
    assert record["resolved"] is True
    assert record["uncached_input_tokens"] == 11
    assert record["cached_input_tokens"] == 7
    assert record["output_tokens"] == 5
    assert record["e2e_seconds"] == 5


def test_scored_model_timeout_is_an_outcome_but_incomplete_trace_fails() -> None:
    timeout = fake_trace(ok=False, timeout=True)
    timeout.rewards = {}
    timeout.reward = 0.0
    timeout.calls[0].error = None
    record = evaluate.trace_record(SimpleNamespace(traces=[timeout], errors=[], ok=False), "suite")
    assert record["resolved"] is False
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
    ((-1, 0), (2, 0), (0, 0), (None, 4)),
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
    assert "task-0" not in markdown


def test_report_fails_drastic_quality_or_efficiency_regression() -> None:
    quality = paired(base_resolved=10, head_resolved=5)
    _, verdict = report.render(quality, request())
    assert verdict == "fail"
    failures = paired()
    for task in failures["sides"]["head"][:3]:
        task["model_failure"] = True
    markdown, verdict = report.render(failures, request())
    assert verdict == "fail"
    assert "Model failures increased by 3" in markdown
    assert "#e5484d" in markdown
    efficiency = paired(base_resolved=10, head_resolved=10, head_multiplier=2)
    markdown, verdict = report.render(efficiency, request())
    assert verdict == "fail"
    assert "without more resolutions" in markdown


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
