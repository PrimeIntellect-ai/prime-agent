"""Launch hosted Prime Evals runs for the Short SWE suite and collect their episodes.

The workflow builds the candidate tarballs, uploads them as GitHub Actions
artifacts, and uses this script to launch one hosted evaluation per configured side and
taskset with the artifact delivered through `custom_secrets`. Each hosted run
executes the private `short-swe-*` Environments Hub packages; their episodes are
pulled back into local `traces.jsonl` files and validated by the same
`evaluate.read_taskset` gates used by the local paired evaluation.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent.parent))

GITHUB_JOB_LIMIT_MINUTES = 360
"""GitHub kills a hosted job at this limit, so every budget below has to fit inside it."""

HOSTED_EVALUATION_TIMEOUT_MINUTES = 240
"""Per-evaluation platform timeout, capped further by the job budget left at launch."""

COLLECT_RESERVE_MINUTES = 20
"""Time kept back after the wait for collection, pairing, and reporting."""

POLL_TIMEOUT_SECONDS = 120
"""Bound on one `prime eval get` call, so a stalled request cannot pass the wait deadline."""

COLLECT_TIMEOUT_SECONDS = 600
"""Bound on one `prime eval samples` call, inside the collection reserve."""

STOP_TIMEOUT_SECONDS = 60
"""Bound on one `prime eval stop` call, so six stalls still leave the finisher time to run."""

JOB_DEADLINE_ENV = "BEHAVIORAL_JOB_DEADLINE_EPOCH"
"""The workflow exports the epoch when the runner kills this job."""

HOSTED_ENVIRONMENTS = {
    "swebench-verified": "primeintellect/short-swe-verified@0.1.13",
    "swebench-pro": "primeintellect/short-swe-pro@0.1.13",
    "scaleswe": "primeintellect/short-swe-scaleswe@0.1.14",
}
EVAL_ID_RE = re.compile(r"Evaluation ID: (\S+)")
TERMINAL_STATUSES = {"COMPLETED", "FAILED", "TIMEOUT", "CANCELLED"}


def run(command: list[str], *, env: dict[str, str] | None = None, timeout: float | None = None) -> str:
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            env={**os.environ, **(env or {})},
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"{command[0]} did not answer within {timeout:.0f}s") from error
    if result.returncode:
        raise RuntimeError(f"{command[0]} failed: {result.stdout}\n{result.stderr}")
    return result.stdout


def job_seconds_left() -> float:
    """Seconds until GitHub kills this job, taken from the deadline the workflow exports."""
    raw = os.environ.get(JOB_DEADLINE_ENV)
    if raw is None:
        raise RuntimeError(f"{JOB_DEADLINE_ENV} is not set, so the job budget is unknown")
    try:
        return float(raw) - time.time()
    except ValueError as error:
        raise RuntimeError(f"{JOB_DEADLINE_ENV} is not a timestamp") from error


def wait_deadline() -> float:
    """Polling stops before the runner would kill the job and skip the stop path."""
    return time.time() + job_seconds_left() - COLLECT_RESERVE_MINUTES * 60


def evaluation_timeout_minutes() -> int:
    """Cap a hosted run so its platform timeout and the collection both fit the job budget."""
    remaining = job_seconds_left() - COLLECT_RESERVE_MINUTES * 60
    if remaining <= 0:
        raise RuntimeError("the behavioral job budget is exhausted before launch")
    return max(1, min(HOSTED_EVALUATION_TIMEOUT_MINUTES, int(remaining // 60)))


def launch(args: argparse.Namespace) -> None:
    request = json.loads(Path(args.request).read_text())
    manifest = json.loads((ROOT / "short-swe.json").read_text())
    model = args.model or manifest["model"]
    if model not in {manifest["model"], manifest["backup_model"]}:
        raise ValueError(f"model {model!r} is not pinned by the Short SWE manifest")
    sizes = {item["id"]: len(item["tasks"]) for item in manifest["tasksets"]}
    sources = json.loads(Path(args.sources).read_text())
    runs: dict[str, dict] = {}
    logs = Path(args.output) / "launch-logs"
    logs.mkdir(parents=True, exist_ok=True)
    sides = tuple(sources)
    for side in sides:
        for taskset_id, environment in HOSTED_ENVIRONMENTS.items():
            source = sources[side]
            secrets = {
                "CANDIDATE_TARBALLS_URL": source["tarballs_url"],
                "CANDIDATE_COMMIT": source["commit"],
                "CANDIDATE_CHECKSUMS": json.dumps(source["checksums"]),
                "CANDIDATE_TOKEN": source.get("token", ""),
            }
            name = f"{request['pr']}-{side}-{taskset_id}-{request['head_sha'][:9]}"
            command = [
                "prime",
                "eval",
                "run",
                environment,
                "--hosted",
                "-m",
                model,
                "-n",
                str(sizes[taskset_id]),
                "-r",
                str(manifest["num_rollouts"]),
                "--max-concurrent",
                str(manifest["max_concurrent"]),
                "--timeout-minutes",
                str(evaluation_timeout_minutes()),
                "--eval-name",
                name,
                "--custom-secrets",
                json.dumps(secrets),
            ]
            log_path = logs / f"{side}-{taskset_id}.log"
            log = log_path.open("w")
            try:
                subprocess.Popen(
                    command,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    text=True,
                )
            except BaseException:
                log.close()
                stop_started(runs)
                raise
            runs[f"{side}/{taskset_id}"] = {
                "environment": environment,
                "name": name,
                "log": str(log_path),
                "num_examples": sizes[taskset_id],
            }
    (Path(args.output) / "hosted-runs.json").write_text(json.dumps(runs, indent=2))
    # Each launch exits right after the platform assigns an evaluation id.
    deadline = time.time() + 300
    assigned: dict[str, str] = {}
    while len(assigned) < len(runs) and time.time() < deadline:
        for key, record in runs.items():
            if key in assigned:
                continue
            text = Path(record["log"]).read_text(errors="replace")
            match = EVAL_ID_RE.search(text)
            if match:
                assigned[key] = match.group(1)
        time.sleep(5)
    missing = [key for key in runs if key not in assigned]
    if missing:
        stop_started(runs)
        for key in missing:
            print(Path(runs[key]["log"]).read_text(errors="replace")[-2000:], file=sys.stderr)
        raise RuntimeError(f"hosted evaluations did not start: {missing}")
    for key, evaluation_id in assigned.items():
        runs[key]["evaluation_id"] = evaluation_id
    (Path(args.output) / "hosted-runs.json").write_text(json.dumps(runs, indent=2))
    print(json.dumps({key: value["evaluation_id"] for key, value in runs.items()}, indent=2))


def stop_started(runs: dict[str, dict]) -> None:
    """Stop every hosted evaluation a partial launch already created."""
    for record in runs.values():
        evaluation_id = record.get("evaluation_id")
        if not evaluation_id:
            try:
                text = Path(record["log"]).read_text(errors="replace")
            except OSError:
                continue
            match = EVAL_ID_RE.search(text)
            if not match:
                continue
            evaluation_id = match.group(1)
        try:
            subprocess.run(
                ["prime", "eval", "stop", evaluation_id],
                capture_output=True,
                text=True,
                timeout=STOP_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            print(f"{evaluation_id}: stop did not answer, leaving it to its own deadline", file=sys.stderr)


def stop(args: argparse.Namespace) -> None:
    """Stop hosted evaluations a cancelled or failed job left running."""
    try:
        runs = json.loads((Path(args.output) / "hosted-runs.json").read_text())
    except (OSError, json.JSONDecodeError):
        return
    stop_started(runs)


def wait(args: argparse.Namespace) -> None:
    runs = json.loads((Path(args.output) / "hosted-runs.json").read_text())
    deadline = wait_deadline()
    failures = []
    try:
        for key, record in runs.items():
            while True:
                remaining = deadline - time.time()
                if remaining <= 0:
                    raise RuntimeError(f"{key}: hosted evaluation did not finish inside the job budget")
                detail = json.loads(
                    run(
                        ["prime", "eval", "get", record["evaluation_id"], "--output", "json"],
                        timeout=min(POLL_TIMEOUT_SECONDS, remaining),
                    )
                )
                status = detail.get("status") or detail.get("evaluation", {}).get("status")
                if status in TERMINAL_STATUSES:
                    break
                time.sleep(30)
            if status != "COMPLETED":
                failures.append(f"{key}: {status} {detail.get('error_message', '')}")
    except BaseException:
        stop_started(runs)
        raise
    if failures:
        raise RuntimeError("; ".join(failures))


def collect(args: argparse.Namespace) -> None:
    runs = json.loads((Path(args.output) / "hosted-runs.json").read_text())
    deadline = time.time() + COLLECT_RESERVE_MINUTES * 60
    for key, record in runs.items():
        side, taskset_id = key.split("/", 1)
        target = Path(args.output) / "raw-eval" / side / taskset_id
        target.mkdir(parents=True, exist_ok=True)
        remaining = deadline - time.time()
        if remaining <= 0:
            raise RuntimeError("collection exceeded its reserve before writing every episode")
        payload = json.loads(
            run(
                ["prime", "eval", "samples", record["evaluation_id"], "--output", "json"],
                timeout=min(COLLECT_TIMEOUT_SECONDS, remaining),
            )
        )
        samples = payload.get("samples") or []
        expected = record.get("num_examples")
        if expected is not None and len(samples) != expected:
            raise RuntimeError(f"{key}: expected {expected} samples, found {len(samples)}")
        episodes = []
        for sample in samples:
            info = sample.get("info") or {}
            native = info.get("native_wrapper")
            if not native:
                raise RuntimeError(f"{key}: sample without a native episode record")
            episodes.append(json.dumps(native))
        (target / "traces.jsonl").write_text("\n".join(episodes) + "\n")
        print(f"{key}: collected {len(episodes)} episodes -> {target}")


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    launch_parser = sub.add_parser("launch")
    launch_parser.add_argument("--request", required=True)
    launch_parser.add_argument("--sources", required=True)
    launch_parser.add_argument("--output", required=True)
    launch_parser.add_argument(
        "--model",
        default=None,
        help="Override the pinned model with its backup when the primary is saturated.",
    )
    launch_parser.set_defaults(func=launch)
    wait_parser = sub.add_parser("wait")
    wait_parser.add_argument("--output", required=True)
    wait_parser.set_defaults(func=wait)
    collect_parser = sub.add_parser("collect")
    collect_parser.add_argument("--output", required=True)
    collect_parser.set_defaults(func=collect)
    stop_parser = sub.add_parser("stop")
    stop_parser.add_argument("--output", required=True)
    stop_parser.set_defaults(func=stop)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
