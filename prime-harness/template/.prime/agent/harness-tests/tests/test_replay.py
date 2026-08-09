from __future__ import annotations

import ast
import copy
import hashlib
import json
import os
import types
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

HARNESS_ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = HARNESS_ROOT / "template"
REPLAY = TEMPLATE / "harness" / "replay.py"
EVALSET = TEMPLATE / "checks" / "evalset"
CORPUS = EVALSET / "corpus.json"
BASELINE = EVALSET / "snapshots" / "baseline-v1.json"
REFERENCE_EXECUTOR = EVALSET / "executors" / "reference_adapter.py"


def canonical_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def load_replay_module(name="prime_harness_replay"):
    if str(REPLAY.parent) not in sys.path:
        sys.path.insert(0, str(REPLAY.parent))
    module = types.ModuleType(name)
    module.__file__ = str(REPLAY)
    exec(compile(REPLAY.read_text(encoding="utf-8"), str(REPLAY), "exec"), module.__dict__)
    return module


def write_json(path: Path, value) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def run(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-S", "harness/replay.py", "--executor", "harness/replay_adapters/behavior_adapter.py", *args],
        cwd=root, capture_output=True, text=True, timeout=120,
    )


@pytest.fixture
def replay_repo(tmp_path):
    root = tmp_path / "repo"
    root.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(root)], check=True, capture_output=True)
    (root / "harness" / "replay_adapters").mkdir(parents=True)
    (root / "checks").mkdir()
    shutil.copy2(REPLAY, root / "harness" / "replay.py")
    shutil.copy2(REPLAY.parent / "numeric_reference.py", root / "harness" / "numeric_reference.py")
    shutil.copytree(EVALSET, root / "checks" / "evalset")
    source = r'''#!/usr/bin/env python3
import json
import math
import sys
from decimal import Decimal, localcontext

payload = json.load(sys.stdin)
challenge = payload["challenge"]
behavior = payload["harness_state"]["local"].get("behavior")
if behavior == "unstable":
    answer = {"repetition": payload.get("repetition")}
elif behavior == "malformed":
    sys.stdout.write("not-json")
    raise SystemExit(0)
elif behavior != "correct":
    answer = {}
elif challenge["category"] == "symbolic":
    contracts = {
        "sym-binomial-square": ("universally_equivalent", []),
        "sym-sqrt-square-sign": ("equivalent_under_assumptions", ["x >= 0"]),
        "sym-log-exp-real": ("universally_equivalent", []),
        "sym-cancel-domain": ("equivalent_under_assumptions", ["x != 0"]),
        "sym-sqrt-product": ("equivalent_under_assumptions", ["a >= 0", "b >= 0"]),
        "sym-missing-cross-term": ("not_equivalent", []),
    }
    verdict, assumptions = contracts[challenge["id"]]
    answer = {"verdict": verdict, "assumptions": assumptions}
    if verdict == "not_equivalent":
        answer["counterexample"] = {"a": 1, "b": 1}
elif challenge["category"] == "convergence":
    n = challenge["resolutions"]
    errors = challenge["errors"]
    orders = [math.log(errors[i] / errors[i + 1]) / math.log(n[i + 1] / n[i]) for i in range(len(errors) - 1)]
    answer = {"observed_order": sum(orders) / len(orders)}
elif challenge["category"] == "invariant":
    series = challenge["series"]
    drift = max(abs(value - series[0]) for value in series) / max(abs(series[0]), challenge["scale_floor"])
    answer = {"conserved": drift <= challenge["rtol"], "relative_drift": drift}
else:
    values = {}
    for digits in challenge["precisions_digits"]:
        with localcontext() as context:
            context.prec = digits + 14
            task_id = challenge["id"]
            if task_id == "num-sqrt-two":
                value = Decimal(2).sqrt(context)
            elif task_id == "num-expm1-cancellation":
                value = Decimal("1e-20").exp(context) - Decimal(1)
            elif task_id == "num-log1p-cancellation":
                value = (Decimal(1) + Decimal("1e-25")).ln(context)
            else:
                value = Decimal("6.67430e-11") * Decimal("5.9722e24") * Decimal("7.342e22") / Decimal("3.844e8")
        values[str(digits)] = format(value, "f")
    answer = {"values": values}
json.dump(answer, sys.stdout, sort_keys=True)
'''
    executor = root / "harness" / "replay_adapters" / "behavior_adapter.py"
    executor.write_text(source, encoding="utf-8", newline="\n")
    digest = hashlib.sha256(executor.read_bytes()).hexdigest()
    checked = json.loads(BASELINE.read_text(encoding="utf-8"))
    baseline = copy.deepcopy(checked)
    baseline.update({"snapshot_id": "before-test", "executor_sha256": digest})
    baseline["harness_state"] = {
        "local": {"behavior": "correct", "entries": {}, "refinements": []},
        "global": {"entries": {}, "refinements": []},
    }
    before = write_json(root / "artifacts" / "harness" / "replay" / "before.json", baseline)
    return root, baseline, before, executor


def candidate_from(baseline: dict, behavior="correct", refinement_id="refine-test-1") -> dict:
    result = copy.deepcopy(baseline)
    result.update({
        "snapshot_id": "candidate-test-1",
        "role": "candidate",
        "refinement_id": refinement_id,
        "parent_snapshot_sha256": canonical_digest(baseline),
        "parent_harness_state_sha256": canonical_digest(baseline["harness_state"]),
    })
    event = {"id": refinement_id, "changes": ["test candidate change"], "created_at": "2026-01-02T00:00:00Z"}
    result["harness_state"] = {
        "local": {
            "behavior": behavior,
            "entries": {"candidate-note": refinement_id},
            "refinements": [*copy.deepcopy(baseline["harness_state"]["local"]["refinements"]), event],
        },
        "global": copy.deepcopy(baseline["harness_state"]["global"]),
    }
    return result


def test_corpus_is_versioned_covered_and_has_thresholds():
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    baseline = json.loads(BASELINE.read_text(encoding="utf-8"))
    assert corpus["schema_version"] == 1 and len(corpus["tasks"]) == 16
    assert {task["category"] for task in corpus["tasks"]} == {"symbolic", "numeric", "convergence", "invariant"}
    assert sum(task["category"] == "symbolic" for task in corpus["tasks"]) >= 4
    assert all(len(task["precisions_digits"]) >= 3 for task in corpus["tasks"] if task["category"] == "numeric")
    assert corpus["promotion_policy"] == {"minimum_category_rate": 0.5, "minimum_score_rate": 0.75, "repetitions": 2}
    replay = load_replay_module("corpus_executor_digest")
    assert corpus["reference_executor_sha256"] == replay._source_digest(REFERENCE_EXECUTOR)
    assert set(corpus["response_contracts"]) == {"symbolic", "numeric", "convergence", "invariant"}
    assert baseline["corpus_sha256"] == canonical_digest(corpus)
    assert "responses" not in baseline





def test_executor_source_digest_is_stable_across_lf_and_crlf(tmp_path):
    replay = load_replay_module("line_ending_digest")
    lf = tmp_path / "lf.py"
    crlf = tmp_path / "crlf.py"
    changed = tmp_path / "changed.py"
    lf.write_bytes(b"print('same')\nraise SystemExit(0)\n")
    crlf.write_bytes(b"print('same')\r\nraise SystemExit(0)\r\n")
    changed.write_bytes(b"print('different')\nraise SystemExit(0)\n")
    assert replay._source_digest(lf) == replay._source_digest(crlf)
    assert replay._source_digest(lf) != replay._source_digest(changed)


def test_numeric_precision_ladder_cannot_be_empty_or_malformed(tmp_path):
    replay = load_replay_module("prime_harness_replay_precision_validation")
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    numeric_task = next(task for task in corpus["tasks"] if task["category"] == "numeric")

    for invalid in ([], [True], [9], [501], ["36"]):
        candidate = copy.deepcopy(corpus)
        next(task for task in candidate["tasks"] if task["id"] == numeric_task["id"])["precisions_digits"] = invalid
        path = write_json(tmp_path / f"corpus-{len(invalid)}-{repr(invalid)}.json", candidate)
        with pytest.raises(replay.ReplayError, match="precisions_digits"):
            replay.load_corpus(path)

    task = copy.deepcopy(numeric_task)
    task["precisions_digits"] = []
    passed, details = replay.verify_numeric(task, {"values": {}}, 0)
    assert not passed
    assert details == {"ladder_passed": 0, "ladder_total": 0, "shape_ok": True}


def test_decimal_expm1_preserves_tiny_nonzero_reference():
    replay = load_replay_module("prime_harness_replay_tiny_expm1")
    assert replay.decimal_expm1("1e-500", 24) != 0
    task = {
        "id": "tiny-expm1",
        "precisions_digits": [10],
        "reference": {"algorithm": "expm1", "value": "1e-500"},
        "tolerance": {"relative": "1e-8"},
    }
    passed, details = replay.verify_numeric(task, {"values": {"10": "0"}}, 0)
    assert not passed
    assert details["ladder_passed"] == 0


def test_executor_command_supports_python_310_without_script_path_imports(tmp_path):
    replay = load_replay_module("prime_harness_replay_python310")
    executor = tmp_path / "adapter.py"
    executor.write_text(
        "import json, sys\njson.dump({'stdlib-json': True}, sys.stdout)\n",
        encoding="utf-8",
    )
    (tmp_path / "json.py").write_text(
        "raise RuntimeError('sibling module imported')\n", encoding="utf-8"
    )
    command = replay._executor_command(executor, (3, 10))
    assert command[:3] == [sys.executable, "-S", "-c"]
    process = subprocess.run(
        command,
        input=b"{}",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=tmp_path,
        timeout=10,
        check=True,
    )
    assert json.loads(process.stdout) == {"stdlib-json": True}
    current = replay._executor_command(executor, (3, 11))
    assert current == [sys.executable, "-P", "-S", str(executor)]


@pytest.mark.skipif(os.name != "nt", reason="Windows descendant teardown contract")
def test_executor_timeout_terminates_windows_descendants(tmp_path):
    replay = load_replay_module("prime_harness_replay_process_tree")
    pid_file = tmp_path / "descendant.pid"
    executor = tmp_path / "spawns_descendant.py"
    executor.write_text(
        "import subprocess, sys, time\n"
        "from pathlib import Path\n"
        f"child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(300)'])\n"
        f"Path({str(pid_file)!r}).write_text(str(child.pid), encoding='ascii')\n"
        "time.sleep(300)\n",
        encoding="utf-8",
    )

    result, error = replay._run_executor(executor, {}, 1.0)
    assert result is None and error == "executor_timeout"
    descendant_pid = int(pid_file.read_text(encoding="ascii"))

    import ctypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    def is_alive(pid):
        handle = kernel32.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        try:
            exit_code = ctypes.c_ulong()
            assert kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))
            return exit_code.value == 259
        finally:
            kernel32.CloseHandle(handle)

    try:
        assert not is_alive(descendant_pid)
    finally:
        if is_alive(descendant_pid):
            subprocess.run(
                ["taskkill", "/PID", str(descendant_pid), "/T", "/F"],
                capture_output=True,
                timeout=15,
            )


def test_executor_honors_pinned_hash_seed_and_scrubs_python_environment(tmp_path, monkeypatch):
    replay = load_replay_module("prime_harness_replay_hash_seed")
    executor = tmp_path / "hash_adapter.py"
    executor.write_text(
        "import json, os, sys\n"
        "json.dump({\"hash\": hash(\"prime-harness\"), "
        "\"order\": list({\"alpha\", \"beta\", \"gamma\", \"delta\"}), "
        "\"pythonpath\": os.environ.get(\"PYTHONPATH\"), "
        "\"seed\": os.environ.get(\"PYTHONHASHSEED\")}, sys.stdout, sort_keys=True)\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("PYTHONPATH", "untrusted-import-root")

    observed = [replay._run_executor(executor, {}, 10.0) for _ in range(4)]
    expected_environment = {
        key: value for key, value in os.environ.items()
        if not key.upper().startswith("PYTHON")
    }
    expected_environment["PYTHONHASHSEED"] = "0"
    expected_process = subprocess.run(
        replay._executor_command(executor),
        input=b"{}",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=10,
        env=expected_environment,
        check=True,
    )
    expected = json.loads(expected_process.stdout)

    assert all(error is None for _, error in observed)
    assert all(value == expected for value, _ in observed)
    assert expected["seed"] == "0"
    assert expected["pythonpath"] is None


def test_replay_imports_only_stdlib():
    tree = ast.parse(REPLAY.read_text(encoding="utf-8"))
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import): imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module: imported.add(node.module.split(".")[0])
    assert imported <= {"argparse", "ast", "decimal", "hashlib", "json", "math", "numeric_reference", "os", "pathlib", "random", "signal", "subprocess", "sys", "tempfile", "typing", "__future__"}


def test_checked_baseline_executes_adapter_and_is_byte_stable_twice(replay_repo):
    root, _, _, _ = replay_repo
    command = [sys.executable, "-S", "harness/replay.py", "--executor", "checks/evalset/executors/reference_adapter.py", "--snapshot", "checks/evalset/snapshots/baseline-v1.json", "--require-perfect"]
    one = subprocess.run(command, cwd=root, capture_output=True, timeout=120)
    two = subprocess.run(command, cwd=root, capture_output=True, timeout=120)
    assert one.returncode == two.returncode == 0, one.stderr + two.stderr
    assert one.stdout == two.stdout
    report = json.loads(one.stdout)
    assert report["snapshot"]["score"] == {"passed": 16, "rate": 1.0, "total": 16}
    assert report["snapshot"]["stable"] and report["snapshot"]["repetitions"] == 2


def test_distinct_digest_bound_behavior_comparison_passes(replay_repo):
    root, baseline, before, _ = replay_repo
    candidate = candidate_from(baseline)
    after = write_json(root / "artifacts/harness/replay/after.json", candidate)
    output = root / "artifacts/harness/replay/comparison.json"
    proc = run(root, "--baseline", str(before), "--candidate", str(after), "--output", str(output), "--require-perfect")
    assert proc.returncode == 0, proc.stderr
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["status"] == report["comparison"]["verdict"] == "pass"
    assert report["comparison"]["eligible_for_promotion"] is True
    assert report["baseline"]["behavior_sha256"] == report["candidate"]["behavior_sha256"]
    assert report["candidate"]["refinement_id"] == "refine-test-1"
    assert report["candidate"]["refinement_event_sha256"] == canonical_digest({"id": "refine-test-1", "changes": ["test candidate change"], "created_at": "2026-01-02T00:00:00Z"})
    assert report["candidate"]["parent_snapshot_sha256"] == canonical_digest(baseline)
    assert report["candidate"]["parent_harness_state_sha256"] == canonical_digest(baseline["harness_state"])
    assert not list(output.parent.glob(f".{output.name}.*.tmp"))


def test_broken_harness_cannot_pass_with_caller_supplied_gold(replay_repo):
    root, baseline, before, _ = replay_repo
    candidate = candidate_from(baseline, behavior="malformed")
    candidate["responses"] = {"forged": "gold"}
    after = write_json(root / "artifacts/harness/replay/after.json", candidate)
    proc = run(root, "--baseline", str(before), "--candidate", str(after))
    assert proc.returncode == 2
    assert "must not contain caller-supplied response bundles" in proc.stderr
    candidate.pop("responses")
    candidate["harness_state"]["local"]["prepared_responses"] = {"forged": "nested-gold"}
    write_json(after, candidate)
    proc = run(root, "--baseline", str(before), "--candidate", str(after))
    assert proc.returncode == 2
    assert "snapshot.harness_state.local.prepared_responses" in proc.stderr
    candidate["harness_state"]["local"].pop("prepared_responses")
    write_json(after, candidate)
    proc = run(root, "--baseline", str(before), "--candidate", str(after))
    assert proc.returncode == 1
    report = json.loads(proc.stdout)
    assert report["candidate"]["score"]["passed"] == 0
    assert report["comparison"]["eligible_for_promotion"] is False
    assert report["status"] == report["comparison"]["verdict"] == "fail"


def test_zero_vs_zero_is_below_threshold_and_verdict_is_unified(replay_repo):
    root, baseline, before, _ = replay_repo
    baseline["harness_state"]["local"]["behavior"] = "wrong"
    write_json(before, baseline)
    candidate = candidate_from(baseline, behavior="wrong")
    after = write_json(root / "artifacts/harness/replay/after.json", candidate)
    proc = run(root, "--baseline", str(before), "--candidate", str(after))
    assert proc.returncode == 1
    report = json.loads(proc.stdout)
    assert report["baseline"]["score"]["passed"] == report["candidate"]["score"]["passed"] == 0
    assert report["status"] == report["comparison"]["verdict"] == "fail"
    assert report["comparison"]["eligible_for_promotion"] is False
    assert any("threshold" in error for error in report["comparison"]["errors"])


def test_require_perfect_changes_the_authoritative_decision(replay_repo):
    root, baseline, before, _ = replay_repo
    candidate = candidate_from(baseline, behavior="wrong")
    after = write_json(root / "artifacts/harness/replay/after.json", candidate)
    proc = run(root, "--baseline", str(before), "--candidate", str(after), "--require-perfect")
    report = json.loads(proc.stdout)
    assert proc.returncode == 1 and report["status"] == "fail"
    assert not report["comparison"]["eligible_for_promotion"]
    assert any("perfect" in error for error in report["comparison"]["errors"])


def test_fabricated_refinement_and_wrong_parent_are_rejected(replay_repo):
    root, baseline, before, _ = replay_repo
    candidate = candidate_from(baseline, refinement_id="fabricated")
    candidate["harness_state"]["local"]["refinements"] = [{"id": "real-id"}]
    candidate["parent_snapshot_sha256"] = "0" * 64
    after = write_json(root / "artifacts/harness/replay/after.json", candidate)
    proc = run(root, "--baseline", str(before), "--candidate", str(after))
    report = json.loads(proc.stdout)
    assert proc.returncode == 1
    errors = report["comparison"]["errors"]
    assert any("refinement history" in error for error in errors)
    assert any("bind the baseline bundle" in error for error in errors)


def test_refinement_history_is_append_only_and_local_scope_is_preserved(replay_repo):
    root, baseline, before, _ = replay_repo
    old_event = {"id": "old-refinement", "changes": ["old change"], "created_at": "2025-01-01T00:00:00Z"}
    baseline["harness_state"]["local"]["refinements"] = [old_event]
    write_json(before, baseline)
    variants = {}
    changed_history = candidate_from(baseline)
    changed_history["harness_state"]["local"]["refinements"][0]["changes"] = ["rewritten"]
    variants["history"] = changed_history
    changed_global = candidate_from(baseline)
    changed_global["harness_state"]["global"]["entries"]["unexpected"] = True
    variants["global"] = changed_global
    no_local_change = candidate_from(baseline)
    no_local_change["harness_state"]["local"]["behavior"] = baseline["harness_state"]["local"]["behavior"]
    no_local_change["harness_state"]["local"]["entries"] = copy.deepcopy(baseline["harness_state"]["local"]["entries"])
    variants["no-local-change"] = no_local_change
    observed = {}
    for label, candidate in variants.items():
        path = write_json(root / f"artifacts/harness/replay/{label}.json", candidate)
        proc = run(root, "--baseline", str(before), "--candidate", str(path))
        assert proc.returncode == 1
        observed[label] = json.loads(proc.stdout)["comparison"]["errors"]
    assert any("preserve baseline events" in error for error in observed["history"])
    assert any("global harness state" in error for error in observed["global"])
    assert any("no local harness change" in error for error in observed["no-local-change"])


def test_executor_digest_and_unstable_behavior_fail_closed(replay_repo):
    root, baseline, before, executor = replay_repo
    baseline["executor_sha256"] = "0" * 64
    write_json(before, baseline)
    stale = root / "artifacts/harness/replay/stale.json"
    stale.write_text('{"status":"pass"}\n', encoding="utf-8")
    proc = run(root, "--snapshot", str(before), "--output", str(stale))
    assert proc.returncode == 2 and "executor_sha256" in proc.stderr
    assert not stale.exists(), "input error must not leave a stale passing report"
    baseline["executor_sha256"] = hashlib.sha256(executor.read_bytes()).hexdigest()
    baseline["harness_state"]["local"]["behavior"] = "unstable"
    write_json(before, baseline)
    proc = run(root, "--snapshot", str(before))
    report = json.loads(proc.stdout)
    assert proc.returncode == 1 and not report["snapshot"]["stable"]


def test_challenge_excludes_oracle_fields():
    replay = load_replay_module()
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    forbidden = {"expected_verdict", "required_assumptions", "trap_samples", "valid_samples", "reference", "expected_order"}
    for task in corpus["tasks"]:
        challenge = replay._challenge(task, corpus)
        assert forbidden.isdisjoint(challenge)


def test_promotion_thresholds_are_probability_bounds():
    replay = load_replay_module("prime_harness_replay_policy")
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    corpus["promotion_policy"]["minimum_score_rate"] = -0.01
    score = {"stable": True, "verification_errors": [], "score": {"passed": 0, "total": 1, "rate": 0.0}, "categories": {"symbolic": {"passed": 0, "total": 1}}}
    with pytest.raises(replay.ReplayError, match="between 0 and 1"):
        replay._policy_failures(score, corpus, False)


def test_tiny_numeric_reference_rejects_zero_at_every_rung():
    replay = load_replay_module("prime_harness_replay_numeric")
    task = next(t for t in json.loads(CORPUS.read_text(encoding="utf-8"))["tasks"] if t["id"] == "num-expm1-cancellation")
    passed, details = replay.verify_numeric(task, {"values": {"18": "0", "36": "0", "72": "0"}}, 0)
    assert not passed and details["ladder_passed"] == 0


def test_paths_are_confined_and_reference_executor_cannot_compare(replay_repo, tmp_path):
    root, baseline, before, _ = replay_repo
    outside = write_json(tmp_path / "outside.json", baseline)
    proc = subprocess.run(
        [sys.executable, "-S", "harness/replay.py", "--repo-root", str(tmp_path), "--executor", "harness/replay_adapters/behavior_adapter.py", "--snapshot", str(before)],
        cwd=root, capture_output=True, text=True, timeout=60,
    )
    assert proc.returncode == 2 and "current working repository" in proc.stderr
    proc = run(root, "--snapshot", str(outside))
    assert proc.returncode == 2 and "outside confined" in proc.stderr
    proc = subprocess.run(
        [sys.executable, "-S", str(REPLAY), "--repo-root", str(root), "--corpus", str(root / "checks/evalset/corpus.json"), "--executor", str(root / "harness/replay_adapters/behavior_adapter.py"), "--snapshot", str(before)],
        cwd=root, capture_output=True, text=True, timeout=60,
    )
    assert proc.returncode == 2 and "not anchored inside repo-root" in proc.stderr
    candidate = candidate_from(baseline)
    after = write_json(root / "artifacts/harness/replay/after.json", candidate)
    proc = subprocess.run(
        [sys.executable, "-S", "harness/replay.py", "--executor", "checks/evalset/executors/reference_adapter.py", "--baseline", str(before), "--candidate", str(after)],
        cwd=root, capture_output=True, text=True, timeout=60,
    )
    assert proc.returncode == 2 and "comparison executor" in proc.stderr
    copied_reference = root / "harness/replay_adapters/copied_reference.py"
    shutil.copy2(root / "checks/evalset/executors/reference_adapter.py", copied_reference)
    proc = subprocess.run(
        [sys.executable, "-S", "harness/replay.py", "--executor", str(copied_reference), "--baseline", str(before), "--candidate", str(after)],
        cwd=root, capture_output=True, text=True, timeout=60,
    )
    assert proc.returncode == 2 and "checked-in reference executor" in proc.stderr
    sentinel = tmp_path / "sentinel"; sentinel.write_text("safe", encoding="utf-8")
    proc = run(root, "--snapshot", str(before), "--output", str(sentinel))
    assert proc.returncode == 2 and sentinel.read_text(encoding="utf-8") == "safe"


def test_nonfinite_json_is_rejected(replay_repo):
    root, _, before, _ = replay_repo
    text = before.read_text(encoding="utf-8").replace('"entries": {}', '"entries": {}, "nonfinite": NaN', 1)
    before.write_text(text, encoding="utf-8")
    proc = run(root, "--snapshot", str(before))
    assert proc.returncode == 2 and "non-finite JSON constant" in proc.stderr


def test_duplicate_keys_and_expression_code_are_not_executed(replay_repo, tmp_path):
    root, baseline, before, _ = replay_repo
    text = before.read_text(encoding="utf-8").replace('"role": "baseline",', '"role": "baseline",\n  "role": "candidate",', 1)
    before.write_text(text, encoding="utf-8")
    proc = run(root, "--snapshot", str(before))
    assert proc.returncode == 2 and "duplicate JSON key" in proc.stderr
    replay_text = (root / "harness/replay.py").read_text(encoding="utf-8")
    assert "eval(" not in replay_text


def test_refinement_step_five_requires_behavior_replay_before_verification():
    prompt = (TEMPLATE / ".prime/agent/prompts/harness-refine.md").read_text(encoding="utf-8")
    step_five = prompt.split("5.", 1)[1]
    for required in ('status="unverified"', "--baseline <before.json> --candidate <after.json>", "parent_snapshot_sha256", "regression", "held-out/gate-passing", "/refine rollback <refinement-id>"):
        assert required in step_five
    assert step_five.index('status="unverified"') < step_five.index("--baseline")


# Closed-schema falsification matrix: every corpus field is either exact or
# has an explicit type/size/range contract.  Each mutation must fail at load
# time with ReplayError, before any weakened task reaches a verifier.
def _corpus_task(corpus: dict, category: str) -> dict:
    return next(task for task in corpus["tasks"] if task["category"] == category)


def _set_task(corpus: dict, category: str, key: str, value) -> None:
    _corpus_task(corpus, category)[key] = value


def _drop_task(corpus: dict, category: str, key: str) -> None:
    _corpus_task(corpus, category).pop(key)


def _set_reference(corpus: dict, key: str, value) -> None:
    _corpus_task(corpus, "numeric")["reference"][key] = value


def _product_task(corpus: dict) -> dict:
    return next(task for task in corpus["tasks"] if task.get("reference", {}).get("algorithm") == "product_divide")


CORPUS_SCHEMA_MUTATIONS = [
    # Root object and bounded policy/provenance fields.
    ("root-unknown", lambda c: c.__setitem__("unexpected", True)),
    ("root-missing-tasks", lambda c: c.pop("tasks")),
    ("schema-version-bool", lambda c: c.__setitem__("schema_version", True)),
    ("schema-version-wrong", lambda c: c.__setitem__("schema_version", 2)),
    ("corpus-version-type", lambda c: c.__setitem__("corpus_version", 1)),
    ("corpus-version-empty", lambda c: c.__setitem__("corpus_version", "")),
    ("corpus-version-long", lambda c: c.__setitem__("corpus_version", "v" * 65)),
    ("seed-bool", lambda c: c.__setitem__("default_seed", True)),
    ("seed-negative", lambda c: c.__setitem__("default_seed", -1)),
    ("seed-too-large", lambda c: c.__setitem__("default_seed", 2**63)),
    ("digest-type", lambda c: c.__setitem__("reference_executor_sha256", 7)),
    ("digest-shape", lambda c: c.__setitem__("reference_executor_sha256", "A" * 64)),
    ("policy-unknown", lambda c: c["promotion_policy"].__setitem__("extra", 1)),
    ("policy-category-bool", lambda c: c["promotion_policy"].__setitem__("minimum_category_rate", True)),
    ("policy-category-low", lambda c: c["promotion_policy"].__setitem__("minimum_category_rate", -0.001)),
    ("policy-category-high", lambda c: c["promotion_policy"].__setitem__("minimum_category_rate", 1.001)),
    ("policy-score-bool", lambda c: c["promotion_policy"].__setitem__("minimum_score_rate", True)),
    ("policy-score-low", lambda c: c["promotion_policy"].__setitem__("minimum_score_rate", -0.001)),
    ("policy-score-high", lambda c: c["promotion_policy"].__setitem__("minimum_score_rate", 1.001)),
    ("policy-repetitions-bool", lambda c: c["promotion_policy"].__setitem__("repetitions", True)),
    ("policy-repetitions-low", lambda c: c["promotion_policy"].__setitem__("repetitions", 1)),
    ("policy-repetitions-high", lambda c: c["promotion_policy"].__setitem__("repetitions", 6)),
    ("contracts-extra-category", lambda c: c["response_contracts"].__setitem__("other", {})),
    ("contracts-extra-field", lambda c: c["response_contracts"]["convergence"].__setitem__("extra", "x")),
    ("contracts-weakened", lambda c: c["response_contracts"]["symbolic"].__setitem__("verdict", "anything")),
    ("tasks-type", lambda c: c.__setitem__("tasks", {})),
    ("tasks-too-few", lambda c: c.__setitem__("tasks", c["tasks"][:11])),
    ("tasks-too-many", lambda c: c.__setitem__("tasks", [dict(c["tasks"][0], id=f"task-{i}") for i in range(257)])),
    # Common task envelope.
    ("task-unknown", lambda c: _set_task(c, "symbolic", "unexpected", 1)),
    ("task-id-type", lambda c: _set_task(c, "symbolic", "id", 1)),
    ("task-id-empty", lambda c: _set_task(c, "symbolic", "id", "")),
    ("task-id-long", lambda c: _set_task(c, "symbolic", "id", "a" * 129)),
    ("task-id-chars", lambda c: _set_task(c, "symbolic", "id", "bad id")),
    ("task-category", lambda c: _set_task(c, "symbolic", "category", "other")),
    ("task-prompt-type", lambda c: _set_task(c, "symbolic", "prompt", 1)),
    ("task-prompt-empty", lambda c: _set_task(c, "symbolic", "prompt", "")),
    ("task-prompt-long", lambda c: _set_task(c, "symbolic", "prompt", "p" * 10001)),
    # Symbolic task oracle and sampling fields.
    ("symbolic-lhs-type", lambda c: _set_task(c, "symbolic", "lhs", 1)),
    ("symbolic-lhs-empty", lambda c: _set_task(c, "symbolic", "lhs", "")),
    ("symbolic-lhs-long", lambda c: _set_task(c, "symbolic", "lhs", "x" * 4097)),
    ("symbolic-rhs-empty", lambda c: _set_task(c, "symbolic", "rhs", "")),
    ("symbolic-verdict", lambda c: _set_task(c, "symbolic", "expected_verdict", "colluding")),
    ("symbolic-random-bool", lambda c: _set_task(c, "symbolic", "random_samples", True)),
    ("symbolic-random-low", lambda c: _set_task(c, "symbolic", "random_samples", -1)),
    ("symbolic-random-high", lambda c: _set_task(c, "symbolic", "random_samples", 1001)),
    ("symbolic-assumptions-type", lambda c: _set_task(c, "symbolic", "required_assumptions", "none")),
    ("symbolic-assumption-empty", lambda c: _set_task(c, "symbolic", "required_assumptions", [""])),
    ("symbolic-assumption-long", lambda c: _set_task(c, "symbolic", "required_assumptions", ["a" * 257])),
    ("symbolic-assumptions-many", lambda c: _set_task(c, "symbolic", "required_assumptions", [f"a{i}" for i in range(65)])),
    ("symbolic-domain-type", lambda c: _set_task(c, "symbolic", "sample_domain", [])),
    ("symbolic-domain-key", lambda c: _set_task(c, "symbolic", "sample_domain", {"bad key": [0, 1]})),
    ("symbolic-domain-many", lambda c: _set_task(c, "symbolic", "sample_domain", {f"x{i}": [0, 1] for i in range(65)})),
    ("symbolic-domain-bounds-type", lambda c: _set_task(c, "symbolic", "sample_domain", {"x": "0,1"})),
    ("symbolic-domain-bounds-shape", lambda c: _set_task(c, "symbolic", "sample_domain", {"x": [0]})),
    ("symbolic-domain-bounds-order", lambda c: _set_task(c, "symbolic", "sample_domain", {"x": [1, 1]})),
    ("symbolic-domain-bounds-magnitude", lambda c: _set_task(c, "symbolic", "sample_domain", {"x": [0, 1e101]})),
    ("symbolic-valid-type", lambda c: _set_task(c, "symbolic", "valid_samples", {})),
    ("symbolic-valid-empty", lambda c: _set_task(c, "symbolic", "valid_samples", [])),
    ("symbolic-valid-many", lambda c: _set_task(c, "symbolic", "valid_samples", [{"x": 0}] * 1001)),
    ("symbolic-valid-point-type", lambda c: _set_task(c, "symbolic", "valid_samples", [1])),
    ("symbolic-valid-point-key", lambda c: _set_task(c, "symbolic", "valid_samples", [{"bad key": 0}])),
    ("symbolic-valid-point-value", lambda c: _set_task(c, "symbolic", "valid_samples", [{"x": "zero"}])),
    ("symbolic-valid-point-magnitude", lambda c: _set_task(c, "symbolic", "valid_samples", [{"x": 1e101}])),
    ("symbolic-traps-type", lambda c: _set_task(c, "symbolic", "trap_samples", {})),
    ("symbolic-traps-many", lambda c: _set_task(c, "symbolic", "trap_samples", [{"x": 0}] * 1001)),
    ("symbolic-required-trap", lambda c: _set_task(c, "symbolic", "expected_verdict", "not_equivalent")),
    # Numeric ladder and reference union.
    ("numeric-precisions-type", lambda c: _set_task(c, "numeric", "precisions_digits", "18")),
    ("numeric-precisions-short", lambda c: _set_task(c, "numeric", "precisions_digits", [18, 36])),
    ("numeric-precisions-many", lambda c: _set_task(c, "numeric", "precisions_digits", list(range(10, 75)))),
    ("numeric-precisions-bool", lambda c: _set_task(c, "numeric", "precisions_digits", [True, 36, 72])),
    ("numeric-precisions-low", lambda c: _set_task(c, "numeric", "precisions_digits", [9, 36, 72])),
    ("numeric-precisions-high", lambda c: _set_task(c, "numeric", "precisions_digits", [18, 36, 501])),
    ("numeric-precisions-order", lambda c: _set_task(c, "numeric", "precisions_digits", [18, 18, 72])),
    ("numeric-mtd-bool", lambda c: _set_task(c, "numeric", "max_tolerance_digits", True)),
    ("numeric-mtd-type", lambda c: _set_task(c, "numeric", "max_tolerance_digits", "60")),
    ("numeric-mtd-low", lambda c: _set_task(c, "numeric", "max_tolerance_digits", 5)),
    ("numeric-mtd-high", lambda c: _set_task(c, "numeric", "max_tolerance_digits", 501)),
    ("numeric-reference-type", lambda c: _set_task(c, "numeric", "reference", [])),
    ("numeric-reference-unknown", lambda c: _set_reference(c, "extra", 1)),
    ("numeric-algorithm", lambda c: _set_reference(c, "algorithm", "eval")),
    ("numeric-value-type", lambda c: _set_reference(c, "value", 2)),
    ("numeric-value-empty", lambda c: _set_reference(c, "value", "")),
    ("numeric-value-long", lambda c: _set_reference(c, "value", "1" * 257)),
    ("numeric-value-nonfinite", lambda c: _set_reference(c, "value", "NaN")),
    ("numeric-value-magnitude", lambda c: _set_reference(c, "value", "1e101")),
    ("numeric-product-factors-empty", lambda c: _product_task(c)["reference"].__setitem__("factors", [])),
    ("numeric-product-factors-many", lambda c: _product_task(c)["reference"].__setitem__("factors", ["1"] * 33)),
    ("numeric-product-factor-type", lambda c: _product_task(c)["reference"].__setitem__("factors", [1])),
    ("numeric-product-divisor-zero", lambda c: _product_task(c)["reference"].__setitem__("divisor", "0")),
    # Convergence sequence and oracle bounds.
    ("convergence-errors-type", lambda c: _set_task(c, "convergence", "errors", "bad")),
    ("convergence-errors-short", lambda c: _set_task(c, "convergence", "errors", [1, 0.5])),
    ("convergence-errors-many", lambda c: _set_task(c, "convergence", "errors", [1 / (i + 1) for i in range(1001)])),
    ("convergence-errors-bool", lambda c: _set_task(c, "convergence", "errors", [1, True, 0.25])),
    ("convergence-errors-zero", lambda c: _set_task(c, "convergence", "errors", [1, 0.5, 0])),
    ("convergence-errors-magnitude", lambda c: _set_task(c, "convergence", "errors", [1e101, 1e100, 1e99])),
    ("convergence-errors-order", lambda c: _set_task(c, "convergence", "errors", [1, 2, 1])),
    ("convergence-resolutions-type", lambda c: _set_task(c, "convergence", "resolutions", "bad")),
    ("convergence-resolutions-short", lambda c: _set_task(c, "convergence", "resolutions", [1, 2])),
    ("convergence-resolutions-bool", lambda c: _set_task(c, "convergence", "resolutions", [1, True, 4])),
    ("convergence-resolutions-order", lambda c: _set_task(c, "convergence", "resolutions", [1, 1, 2, 3])),
    ("convergence-length-mismatch", lambda c: _set_task(c, "convergence", "resolutions", [1, 2, 4])),
    ("convergence-order-bool", lambda c: _set_task(c, "convergence", "expected_order", True)),
    ("convergence-order-low", lambda c: _set_task(c, "convergence", "expected_order", 0)),
    ("convergence-order-high", lambda c: _set_task(c, "convergence", "expected_order", 101)),
    ("convergence-tolerance-bool", lambda c: _set_task(c, "convergence", "order_tolerance", True)),
    ("convergence-tolerance-low", lambda c: _set_task(c, "convergence", "order_tolerance", 0)),
    ("convergence-tolerance-high", lambda c: _set_task(c, "convergence", "order_tolerance", 0.5001)),
    # Invariant sequence and all three tolerance/scale bounds.
    ("invariant-series-type", lambda c: _set_task(c, "invariant", "series", "bad")),
    ("invariant-series-short", lambda c: _set_task(c, "invariant", "series", [1, 1])),
    ("invariant-series-many", lambda c: _set_task(c, "invariant", "series", [1] * 10001)),
    ("invariant-series-bool", lambda c: _set_task(c, "invariant", "series", [1, True, 1])),
    ("invariant-series-magnitude", lambda c: _set_task(c, "invariant", "series", [1e101, 1, 1])),
    ("invariant-rtol-missing", lambda c: _drop_task(c, "invariant", "rtol")),
    ("invariant-rtol-bool", lambda c: _set_task(c, "invariant", "rtol", True)),
    ("invariant-rtol-low", lambda c: _set_task(c, "invariant", "rtol", 0)),
    ("invariant-rtol-high", lambda c: _set_task(c, "invariant", "rtol", 1)),
    ("invariant-report-missing", lambda c: _drop_task(c, "invariant", "report_tolerance")),
    ("invariant-report-bool", lambda c: _set_task(c, "invariant", "report_tolerance", True)),
    ("invariant-report-low", lambda c: _set_task(c, "invariant", "report_tolerance", 0)),
    ("invariant-report-high", lambda c: _set_task(c, "invariant", "report_tolerance", 1)),
    ("invariant-floor-missing", lambda c: _drop_task(c, "invariant", "scale_floor")),
    ("invariant-floor-bool", lambda c: _set_task(c, "invariant", "scale_floor", True)),
    ("invariant-floor-low", lambda c: _set_task(c, "invariant", "scale_floor", 0)),
    ("invariant-floor-high", lambda c: _set_task(c, "invariant", "scale_floor", 1.0001)),
]


@pytest.mark.parametrize(
    "label,mutate", CORPUS_SCHEMA_MUTATIONS, ids=[case[0] for case in CORPUS_SCHEMA_MUTATIONS],
)
def test_entire_corpus_has_closed_bounded_schema(tmp_path, label, mutate):
    replay = load_replay_module(f"prime_harness_replay_schema_{label.replace('-', '_')}")
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    mutate(corpus)
    path = write_json(tmp_path / f"{label}.json", corpus)
    with pytest.raises(replay.ReplayError):
        replay.load_corpus(path)


def test_oracle_bounds_are_defended_again_inside_category_verifiers():
    replay = load_replay_module("prime_harness_replay_dual_schema_guards")
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))

    numeric = copy.deepcopy(_corpus_task(corpus, "numeric"))
    numeric["max_tolerance_digits"] = "60"
    with pytest.raises(replay.ReplayError, match="max_tolerance_digits"):
        replay.verify_numeric(numeric, {"values": {"18": "0", "36": "0", "72": "0"}}, 0)

    convergence = copy.deepcopy(_corpus_task(corpus, "convergence"))
    convergence["order_tolerance"] = 1
    with pytest.raises(replay.ReplayError, match="order_tolerance"):
        replay.verify_convergence(convergence, {"observed_order": 1}, 0)

    invariant = copy.deepcopy(_corpus_task(corpus, "invariant"))
    invariant["rtol"] = 1
    with pytest.raises(replay.ReplayError, match="rtol"):
        replay.verify_invariant(invariant, {"conserved": True, "relative_drift": 0}, 0)

    symbolic = copy.deepcopy(_corpus_task(corpus, "symbolic"))
    symbolic["expected_verdict"] = "colluding"
    with pytest.raises(replay.ReplayError, match="expected_verdict"):
        replay.verify_symbolic(symbolic, {"verdict": "colluding", "assumptions": []}, 0)


def test_invalid_corpus_contract_uses_exit_two_and_removes_stale_output(replay_repo):
    root, _, before, _ = replay_repo
    corpus_path = root / "checks/evalset/corpus.json"
    corpus = json.loads(corpus_path.read_text(encoding="utf-8"))
    _corpus_task(corpus, "numeric")["max_tolerance_digits"] = "abc"
    write_json(corpus_path, corpus)
    stale = root / "artifacts/harness/replay/stale-corpus.json"
    stale.parent.mkdir(parents=True, exist_ok=True)
    stale.write_text('{"status":"pass"}\n', encoding="utf-8")
    proc = run(root, "--snapshot", str(before), "--output", str(stale))
    assert proc.returncode == 2
    assert "max_tolerance_digits" in proc.stderr
    assert not stale.exists()


def test_zero_promotion_thresholds_are_rejected_as_vacuous(tmp_path):
    replay = load_replay_module("prime_harness_replay_zero_threshold")
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    corpus["promotion_policy"]["minimum_category_rate"] = 0
    corpus["promotion_policy"]["minimum_score_rate"] = 0
    with pytest.raises(replay.ReplayError, match="minimum_.*_rate"):
        replay.load_corpus(write_json(tmp_path / "zero-thresholds.json", corpus))


def test_symbolic_expression_depth_fails_with_replay_error(tmp_path):
    replay = load_replay_module("prime_harness_replay_expression_depth")
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    task = _corpus_task(corpus, "symbolic")
    task["lhs"] = "+".join(["1"] * 1500)
    task["rhs"] = task["lhs"]
    with pytest.raises(replay.ReplayError, match="expression"):
        replay.load_corpus(write_json(tmp_path / "deep-expression.json", corpus))


def test_huge_json_integer_fails_with_replay_error(tmp_path):
    replay = load_replay_module("prime_harness_replay_huge_integer")
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    _corpus_task(corpus, "convergence")["expected_order"] = 10**1000
    with pytest.raises(replay.ReplayError, match="expected_order"):
        replay.load_corpus(write_json(tmp_path / "huge-integer.json", corpus))


def test_oversized_integer_literal_is_wrapped_as_replay_error(tmp_path):
    replay = load_replay_module("prime_harness_replay_integer_literal_limit")
    corpus_text = CORPUS.read_text(encoding="utf-8")
    corpus_text = corpus_text.replace('"default_seed": 20260808', '"default_seed": ' + "9" * 5000, 1)
    path = tmp_path / "oversized-integer-literal.json"
    path.write_text(corpus_text, encoding="utf-8")
    with pytest.raises(replay.ReplayError, match="invalid JSON"):
        replay.load_corpus(path)
