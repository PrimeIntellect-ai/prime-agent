#!/usr/bin/env python3
"""Run the fixed base/head Short SWE comparison and read native Verifiers episodes."""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TRACE_FILE_LIMIT = 50_000_000


def task_name(trace) -> str:
    name = getattr(trace.task.data, "name", None)
    if not isinstance(name, str) or not name:
        raise ValueError("trace has no task name")
    return name.rsplit("/", 1)[-1]


def scored(trace) -> bool:
    return bool(trace.rewards) and all(reward is not None for reward in trace.rewards.values())


def recognized_model_failure(trace) -> bool:
    if not trace.errors:
        return False
    terminal = trace.errors[-1]
    if (
        terminal.type == "ProviderError"
        and terminal.status_code in {400, 413, 422}
        and any(
            call.error is not None
            and call.error.type == terminal.type
            and call.error.status_code == terminal.status_code
            and call.error.message == terminal.message
            for call in trace.calls
        )
    ):
        return True
    return (
        terminal.type == "HarnessError"
        and terminal.message.startswith("agent timeout: rollout exceeded its ")
        and terminal.message.endswith(" budget")
    )


def accepted_model_outcome(trace) -> bool:
    if not trace.is_completed:
        return False
    return scored(trace) if trace.ok else recognized_model_failure(trace)


def validate_graph(trace) -> None:
    for index, node in enumerate(trace.nodes):
        parent = node.parent
        if parent is not None and (
            not isinstance(parent, int) or isinstance(parent, bool) or not 0 <= parent < index
        ):
            raise ValueError("trace has an invalid parent link")
    for call in trace.calls:
        node = call.node
        if node is None:
            continue
        if (
            not isinstance(node, int)
            or isinstance(node, bool)
            or not 0 <= node < len(trace.nodes)
            or not trace.nodes[node].sampled
        ):
            raise ValueError("model call has an invalid message node")


def validate_timing(trace) -> float:
    total = 0.0
    for phase in ("boot", "setup", "agent", "finalize", "scoring"):
        span = getattr(trace.timing, phase)
        start, end = span.start, span.end
        if (
            any(
                not isinstance(value, (int, float))
                or isinstance(value, bool)
                or not math.isfinite(value)
                or value < 0
                for value in (start, end)
            )
            or bool(start) != bool(end)
            or end < start
        ):
            raise ValueError("trace has invalid timing")
        total += span.duration
    verifier = getattr(trace, "info", {}).get("isolated_verifier_seconds", 0.0)
    if (
        not isinstance(verifier, (int, float))
        or isinstance(verifier, bool)
        or not math.isfinite(verifier)
        or verifier < 0
    ):
        raise ValueError("trace has invalid isolated verifier timing")
    return total + verifier


def provider_usage(trace, identity: str):
    for call in trace.calls:
        if call.error is not None:
            continue
        usage = call.usage
        values = (
            usage.prompt_tokens if usage else None,
            usage.cached_input_tokens if usage else None,
            usage.completion_tokens if usage else None,
        )
        if any(not isinstance(value, int) or isinstance(value, bool) or value < 0 for value in values):
            raise ValueError(f"{identity} has incomplete provider usage")
    usage = trace.usage
    if usage is None or usage.cached_input_tokens is None:
        raise ValueError(f"{identity} has incomplete provider usage")
    return usage


def trace_record(episode, taskset: str) -> dict:
    if len(episode.traces) != 1:
        raise ValueError("single-agent Short SWE episode must contain one trace")
    trace = episode.traces[0]
    identity = f"{taskset}/{task_name(trace)}"
    if episode.errors or not accepted_model_outcome(trace):
        raise ValueError(f"{identity} did not produce a complete trace or model outcome")
    validate_graph(trace)
    _ = trace.branches
    usage = provider_usage(trace, identity)
    rewards = [
        value for reward in trace.rewards.values() if reward for value in (reward.score, reward.weight)
    ]
    if any(isinstance(value, bool) or not math.isfinite(value) for value in rewards):
        raise ValueError(f"{identity} has invalid reward values")
    return {
        "taskset": taskset,
        "task": task_name(trace),
        "resolved": scored(trace) and trace.reward > 0,
        "model_failure": not trace.ok,
        "uncached_input_tokens": usage.prompt_tokens,
        "cached_input_tokens": usage.cached_input_tokens,
        "output_tokens": usage.completion_tokens,
        "e2e_seconds": validate_timing(trace),
        "model_calls": len(trace.calls),
    }


def read_taskset(path: Path, taskset: str) -> list[dict]:
    from verifiers.v1.cli.output import read_episodes
    from verifiers.v1.trace import WireTrace

    files = list(path.rglob("traces.jsonl"))
    if len(files) != 1:
        raise ValueError(f"{taskset} produced {len(files)} trace files")
    if files[0].stat().st_size > TRACE_FILE_LIMIT:
        raise ValueError(f"{taskset} trace file exceeds its size limit")
    return [trace_record(episode, taskset) for episode in read_episodes(files[0].parent, WireTrace)]


def validate_tasks(records: list[dict], manifest: dict) -> None:
    expected = {(item["id"], task) for item in manifest["tasksets"] for task in item["tasks"]}
    actual = {(record["taskset"], record["task"]) for record in records}
    if actual != expected or len(records) != len(expected):
        raise ValueError("trace task identities differ from the fixed 15/8/5 manifest")


def validate_oracle_episode(episode) -> None:
    if len(episode.traces) != 1:
        raise RuntimeError("SWE-bench oracle did not produce one trace")
    trace = episode.traces[0]
    if (
        episode.errors
        or task_name(trace) != "astropy__astropy-14096"
        or not trace.ok
        or not trace.is_completed
        or not scored(trace)
        or trace.reward <= 0
    ):
        raise RuntimeError("SWE-bench gold-patch oracle did not resolve")


def run_oracle(executable: Path, config: Path, output: Path) -> None:
    from verifiers.v1.cli.output import read_episodes
    from verifiers.v1.trace import WireTrace

    target = output / "oracle"
    target.mkdir(parents=True, exist_ok=True)
    environment = {**os.environ, "PYTHONPATH": str(ROOT)}
    with (target / "eval.log").open("w") as log:
        completed = subprocess.run(
            [str(executable), "@", str(config), "--output-dir", str(target), "--no-push"],
            env=environment,
            stdout=log,
            stderr=subprocess.STDOUT,
            check=False,
        )
    if completed.returncode:
        raise RuntimeError(f"SWE-bench oracle exited with status {completed.returncode}")
    files = list(target.rglob("traces.jsonl"))
    if len(files) != 1 or files[0].stat().st_size > TRACE_FILE_LIMIT:
        raise RuntimeError("SWE-bench oracle trace output is invalid")
    episodes = list(read_episodes(files[0].parent, WireTrace))
    if len(episodes) != 1:
        raise RuntimeError("SWE-bench oracle did not produce one episode")
    validate_oracle_episode(episodes[0])


def run_all(executable: Path, configs: Path, output: Path) -> dict[str, list[dict]]:
    environment = {**os.environ, "PYTHONPATH": str(ROOT)}
    processes = {}
    output.mkdir(parents=True, exist_ok=True)
    for side in ("base", "head"):
        for config in sorted((configs / side).glob("*.toml")):
            target = output / side / config.stem
            target.mkdir(parents=True)
            log = (target / "eval.log").open("w")
            command = [str(executable), "@", str(config), "--output-dir", str(target), "--no-push"]
            processes[(side, config.stem)] = (
                subprocess.Popen(command, env=environment, stdout=log, stderr=subprocess.STDOUT),
                log,
            )
    failures = []
    for key, (process, log) in processes.items():
        code = process.wait()
        log.close()
        if code:
            failures.append(f"{key[0]}/{key[1]} exited with status {code}")
    if failures:
        raise RuntimeError("; ".join(failures))
    return {
        side: [
            record
            for taskset in sorted((configs / side).glob("*.toml"))
            for record in read_taskset(output / side / taskset.stem, taskset.stem)
        ]
        for side in ("base", "head")
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--eval", required=True, type=Path)
    parser.add_argument("--configs", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--result", required=True, type=Path)
    args = parser.parse_args()
    manifest = json.loads((ROOT / "short-swe.json").read_text())
    request = json.loads(args.request.read_text())
    try:
        run_oracle(args.eval, args.configs / "oracle.toml", args.output)
        started = time.time()
        sides = run_all(args.eval, args.configs, args.output)
        for records in sides.values():
            validate_tasks(records, manifest)
        result = {
            "schema_version": 1,
            "request": request,
            "model": manifest["model"],
            "started_at": started,
            "finished_at": time.time(),
            "sides": sides,
        }
        args.result.parent.mkdir(parents=True, exist_ok=True)
        args.result.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    except Exception as error:
        args.output.mkdir(parents=True, exist_ok=True)
        (args.output / "failure.txt").write_text(f"{type(error).__name__}: {error}\n")
        raise


if __name__ == "__main__":
    main()
