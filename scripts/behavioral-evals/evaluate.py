#!/usr/bin/env python3
"""Run the three immutable Short SWE slices concurrently and extract objective metrics."""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any

from trace_analyzer import Limits, analyze_trace

ROOT = Path(__file__).resolve().parent
TRACE_FILE_LIMIT = 50_000_000
TRACE_LINE_LIMIT = 10_000_000
TRACE_RECORD_LIMIT = 1_000
ANALYZER_LIMITS = Limits(max_events=20_000, max_string=100_000, max_list=20)
EXIT_CODE_RE = re.compile(r"\bexit_code\s*[=:]\s*(-?\d+)\b")
FRAMEWORK_LIMIT_STOPS = frozenset({"max_turns", "max_input_tokens", "max_output_tokens", "max_total_tokens"})


def completion_tokens(trace: dict) -> int:
    total = 0
    for call in trace.get("calls", []):
        usage = call.get("usage") or {}
        value = usage.get("completion_tokens", usage.get("output_tokens", 0))
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            total += value
    return total


def elapsed(trace: dict) -> float:
    timing = trace.get("timing") or {}
    start = timing.get("start")
    ends = []
    for key in ("boot", "setup", "agent", "finalize", "scoring"):
        span = timing.get(key) or {}
        end = span.get("end")
        if isinstance(end, (int, float)) and not isinstance(end, bool):
            ends.append(float(end))
    if isinstance(start, (int, float)) and not isinstance(start, bool) and ends:
        return max(0.0, max(ends) - float(start))
    total = 0.0
    for key in ("boot", "setup", "agent", "finalize", "scoring"):
        span = timing.get(key) or {}
        begin, end = span.get("start"), span.get("end")
        if all(isinstance(value, (int, float)) for value in (begin, end)):
            total += max(0.0, float(end) - float(begin))
    return total


def reward(trace: dict) -> float:
    total = 0.0
    for item in (trace.get("rewards") or {}).values():
        if isinstance(item, dict) and isinstance(item.get("score"), (int, float)):
            total += float(item["score"]) * float(item.get("weight", 1.0))
    return total


def command_from(arguments: Any) -> str | None:
    if isinstance(arguments, str):
        try:
            value = json.loads(arguments)
        except json.JSONDecodeError:
            return arguments
    else:
        value = arguments
    if not isinstance(value, dict):
        return None
    for key in ("command", "code"):
        if isinstance(value.get(key), str):
            return value[key]
    return None


def nested_python_tools(
    code: str,
    parent_id: str,
    result_status: str = "unknown",
    result_exit_code: int | None = None,
) -> list[dict]:
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return []
    events = []
    for index, statement in enumerate(tree.body, start=1):
        expression = statement.value if isinstance(statement, (ast.Expr, ast.Assign, ast.AnnAssign)) else None
        if isinstance(expression, ast.Await):
            expression = expression.value
        if not isinstance(expression, ast.Call):
            continue
        function = expression.func
        name = function.id if isinstance(function, ast.Name) else None
        if name not in {"bash", "edit"}:
            continue
        command = None
        if (
            expression.args
            and isinstance(expression.args[0], ast.Constant)
            and isinstance(expression.args[0].value, str)
        ):
            command = expression.args[0].value
        for keyword in expression.keywords:
            if (
                keyword.arg in {"command", "path"}
                and isinstance(keyword.value, ast.Constant)
                and isinstance(keyword.value.value, str)
            ):
                command = keyword.value.value
        events.append(
            {
                "type": "tool",
                "id": f"{parent_id}:nested:{index}",
                "tool": f"cpython_{name}",
                "command": command or "",
                "status": "unknown",
            }
        )
    if events and result_status != "unknown":
        events[-1]["status"] = result_status
        events[-1]["exit_code"] = result_exit_code
    return events


def tool_result_event(message: dict) -> dict:
    content = message.get("content", "")
    text = content if isinstance(content, str) else json.dumps(content, sort_keys=True)
    status = "unknown"
    exit_code = None
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        parsed = None
    if isinstance(parsed, dict):
        value = parsed.get("exit_code")
        if isinstance(value, int) and not isinstance(value, bool):
            exit_code = value
            status = "ok" if value == 0 else "error"
        declared = parsed.get("status")
        if declared in {"ok", "success", "succeeded"}:
            status = "ok"
        elif declared in {"error", "failed", "failure"} or parsed.get("error") is True:
            status = "error"
        elif declared in {"timeout", "timed_out"}:
            status = "timeout"
    else:
        matches = EXIT_CODE_RE.findall(text)
        if matches:
            exit_code = int(matches[-1])
            status = "ok" if exit_code == 0 else "error"
        lowered = text.lower()
        if "timed out" in lowered or "timeouterror" in lowered:
            status = "timeout"
        elif text.lstrip().startswith("Traceback (most recent call last):"):
            status = "error"
    return {
        "type": "tool_result",
        "call_id": str(message.get("tool_call_id", "")),
        "status": status,
        "exit_code": exit_code,
        "content": text,
    }


def analyzer_input(trace: dict) -> dict:
    events = []
    advertised = [item.get("name") for item in trace.get("tools", []) if item.get("name")]
    nodes = trace.get("nodes", [])
    result_by_call = {}
    result_by_node = {}
    for index, node in enumerate(nodes):
        message = node.get("message") or node
        if message.get("role") != "tool":
            continue
        result = tool_result_event(message)
        previous = result_by_call.get(result["call_id"])
        if previous is None:
            result_by_call[result["call_id"]] = result
            result_by_node[index] = result
        elif result != previous:
            result_by_node[index] = result
    for index, node in enumerate(nodes):
        message = node.get("message") or node
        role = message.get("role")
        if role == "assistant" and node.get("sampled") is not False:
            text = message.get("content")
            if isinstance(text, str) and text:
                events.append({"type": "message", "role": "assistant", "text": text})
            for call in message.get("tool_calls") or []:
                call_id = str(call.get("id", ""))
                tool = str(call.get("name", ""))
                command = command_from(call.get("arguments"))
                events.append(
                    {
                        "type": "tool_call",
                        "id": call_id,
                        "tool": tool,
                        "command": command or "",
                    }
                )
                if tool in {"cpython", "ipython"} and command:
                    result = result_by_call.get(call_id, {})
                    events.extend(
                        nested_python_tools(
                            command,
                            call_id,
                            result.get("status", "unknown"),
                            result.get("exit_code"),
                        )
                    )
        elif role == "tool" and index in result_by_node:
            events.append(result_by_node[index])
    supported = [
        *(advertised or ["cpython", "ipython"]),
        "cpython_bash",
        "cpython_edit",
    ]
    return {"supported_tools": supported, "events": events}


def analyzer_integrity_issues(facts: dict, *, allow_unanswered: bool = False) -> int:
    meta = facts.get("meta")
    if not isinstance(meta, dict):
        return 0
    dropped = meta.get("dropped_events")
    dropped_count = (
        sum(value for value in dropped.values() if isinstance(value, int)) if isinstance(dropped, dict) else 0
    )
    unanswered = 0 if allow_unanswered else int(meta.get("unanswered_calls") or 0)
    return (
        dropped_count
        + int(bool(meta.get("truncated_input")))
        + int(meta.get("truncated_strings") or 0)
        + unanswered
    )


def failure_stage(trace: dict) -> str | None:
    errors = trace.get("errors") or []
    detail = " ".join(
        f"{item.get('type', '')} {item.get('message', '')}" for item in errors if isinstance(item, dict)
    ).lower()
    stages = (
        ("acp", ("acp", "agent client protocol")),
        ("cpython", ("cpython", "ipython", "kernel bootstrap", "kernel process")),
        ("install", ("install", "npm", "bootstrap")),
        ("launch", ("provision", "launch", "sandbox", "connect rpc")),
        ("cleanup", ("cleanup", "finalize")),
    )
    for stage, markers in stages:
        if any(marker in detail for marker in markers):
            return stage
    if errors and not any(marker in detail for marker in ("timeout", "timed out", "nontermination")):
        return "trace_integrity"
    return None


def error_flags(trace: dict) -> tuple[bool, bool]:
    errors = trace.get("errors") or []
    detail = " ".join(
        f"{item.get('type', '')} {item.get('message', '')}" for item in errors if isinstance(item, dict)
    ).lower()
    calls = len(trace.get("calls") or [])
    timeout = calls > 0 and any(word in detail for word in ("timeout", "timed out", "nontermination"))
    infrastructure = bool(errors) and calls == 0
    return timeout, infrastructure


def tool_call_count(trace: dict) -> int:
    count = 0
    for node in trace.get("nodes", []):
        if node.get("sampled") is False:
            continue
        message = node.get("message") or node
        count += len(message.get("tool_calls") or [])
    return count


def task_name(trace: dict) -> str:
    data = (trace.get("task") or {}).get("data") or {}
    name = data.get("name")
    if not isinstance(name, str) or not name:
        raise ValueError("trace has no task name")
    return name.rsplit("/", 1)[-1]


def trace_record(episode: dict, taskset: str) -> dict:
    traces = episode.get("traces")
    if not isinstance(traces, list):
        raise TypeError("trace file row has no traces list")
    if len(traces) > 1:
        raise ValueError("single-agent Short SWE episode produced multiple traces")
    trace = traces[0] if traces else {"task": episode.get("task"), "errors": []}
    trace = {
        **trace,
        "errors": [*(episode.get("errors") or []), *(trace.get("errors") or [])],
    }
    timeout, infrastructure = error_flags(trace)
    if not traces and episode.get("errors"):
        infrastructure = True
    facts = analyze_trace(analyzer_input(trace), ANALYZER_LIMITS)
    meta = facts.get("meta") if isinstance(facts.get("meta"), dict) else {}
    unanswered = int(meta.get("unanswered_calls") or 0)
    limit_stop = trace.get("stop_condition") in FRAMEWORK_LIMIT_STOPS
    integrity_issues = analyzer_integrity_issues(facts, allow_unanswered=limit_stop)
    fact_counts = {
        key: value["count"]
        for key, value in facts.items()
        if isinstance(value, dict) and isinstance(value.get("count"), int)
    }
    after_edit = facts["tests_after_final_edit"]["ran_after_final_edit"]
    if after_edit is False:
        fact_counts["no_test_after_final_edit"] = 1
    if limit_stop and unanswered:
        fact_counts["pending_calls_at_limit"] = unanswered
    if integrity_issues:
        fact_counts["trace_integrity_issues"] = integrity_issues
    trace_complete = (
        bool(episode.get("ok"))
        and bool(trace.get("is_completed"))
        and bool(trace.get("ok"))
        and integrity_issues == 0
    )
    if not trace_complete:
        fact_counts["incomplete_trace"] = 1
    return {
        "taskset": taskset,
        "task": task_name(episode),
        "resolved": reward(trace) > 0,
        "output_tokens": completion_tokens(trace),
        "e2e_seconds": elapsed(trace),
        "model_calls": len(trace.get("calls") or []),
        "tool_calls": tool_call_count(trace),
        "model_timeout": timeout,
        "infrastructure_error": infrastructure,
        "failure_stage": failure_stage(trace),
        "retries": 0,
        "trace_facts": fact_counts,
        "trace_complete": trace_complete,
    }


def read_trace_records(path: Path, taskset: str) -> list[dict]:
    records = []
    total = 0
    with path.open("rb") as stream:
        while line := stream.readline(TRACE_LINE_LIMIT + 1):
            total += len(line)
            if len(line) > TRACE_LINE_LIMIT:
                raise ValueError(f"{taskset} trace row exceeds its size limit")
            if total > TRACE_FILE_LIMIT:
                raise ValueError(f"{taskset} trace file exceeds its size limit")
            if not line.strip():
                continue
            if len(records) >= TRACE_RECORD_LIMIT:
                raise ValueError(f"{taskset} trace file has too many rows")
            records.append(trace_record(json.loads(line), taskset))
    return records


def run_all(
    executable: Path,
    configs: Path,
    output: Path,
    plugin_path: Path,
    *,
    retry_pre_model: bool = True,
    stats: dict[str, int] | None = None,
) -> list[dict]:
    if stats is None:
        stats = {"taskset_retries": 0}
    output.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "PYTHONPATH": str(plugin_path.resolve())}
    processes = {}
    config_by_taskset = {}
    for config in sorted(configs.glob("*.toml")):
        taskset = config.stem
        config_by_taskset[taskset] = config
        run_dir = output / taskset
        run_dir.mkdir(parents=True, exist_ok=True)
        log = (run_dir / "eval.log").open("w")
        command = [
            str(executable),
            "@",
            str(config),
            "--output-dir",
            str(run_dir),
            "--no-push",
        ]
        processes[taskset] = (
            subprocess.Popen(command, env=env, stdout=log, stderr=subprocess.STDOUT),
            log,
        )
    return_codes = {}
    for taskset, (process, log) in processes.items():
        return_codes[taskset] = process.wait()
        log.close()

    records = []
    retry_tasksets = []
    for taskset in sorted(processes):
        files = sorted((output / taskset).rglob("traces.jsonl"))
        taskset_records = []
        if len(files) == 1:
            taskset_records = read_trace_records(files[0], taskset)
        return_code = return_codes[taskset]
        if (len(files) != 1 or not taskset_records) and return_code:
            retry_tasksets.append(taskset)
            continue
        if len(files) != 1:
            raise ValueError(f"{taskset} produced {len(files)} trace files")
        if return_code:
            raise RuntimeError(f"{taskset} evaluation exited with status {return_code}")
        if not taskset_records:
            raise ValueError(f"{taskset} produced no trace rows")
        records.extend(taskset_records)
    if retry_tasksets:
        if not retry_pre_model:
            raise RuntimeError(
                "evaluation failed before producing traces after one retry: " + ", ".join(retry_tasksets)
            )
        stats["taskset_retries"] += len(retry_tasksets)
        retry_configs = output / "pre-model-retry-configs"
        retry_configs.mkdir()
        for taskset in retry_tasksets:
            (retry_configs / f"{taskset}.toml").write_text(config_by_taskset[taskset].read_text())
        records.extend(
            run_all(
                executable,
                retry_configs,
                output / "pre-model-retry",
                plugin_path,
                retry_pre_model=False,
                stats=stats,
            )
        )
    return records


def validate_tasks(records: list[dict], manifest: dict) -> None:
    expected = {(item["id"], task) for item in manifest["tasksets"] for task in item["tasks"]}
    actual = {(record["taskset"], record["task"]) for record in records}
    if actual != expected or len(records) != len(expected):
        missing = len(expected - actual)
        extra = len(actual - expected)
        raise ValueError(f"trace task identities differ from the manifest ({missing} missing, {extra} extra)")


def validate_complete(records: list[dict]) -> None:
    incomplete = [
        f"{record['taskset']}/{record['task']}" for record in records if not record.get("trace_complete")
    ]
    if incomplete:
        raise RuntimeError("evaluation produced incomplete traces: " + ", ".join(incomplete))


def retry_infrastructure_failures(
    executable: Path,
    records: list[dict],
    manifest: dict,
    artifacts: Path,
    commit: str,
    output: Path,
    stats: dict[str, int] | None = None,
) -> list[dict]:
    failed = {(record["taskset"], record["task"]) for record in records if record["infrastructure_error"]}
    if not failed:
        return records
    from prepare import config_text

    configs = output / "retry-configs"
    configs.mkdir(parents=True, exist_ok=True)
    retry_manifest = {**manifest, "tasksets": []}
    for item in manifest["tasksets"]:
        tasks = [task for task in item["tasks"] if (item["id"], task) in failed]
        if not tasks:
            continue
        narrowed = {**item, "tasks": tasks}
        retry_manifest["tasksets"].append(narrowed)
        (configs / f"{item['id']}.toml").write_text(config_text(narrowed, manifest, artifacts, commit))
    retried = run_all(
        executable,
        configs,
        output / "retry",
        ROOT,
        stats=stats,
    )
    validate_tasks(retried, retry_manifest)
    replacements = {(record["taskset"], record["task"]): {**record, "retries": 1} for record in retried}
    return [replacements.get((record["taskset"], record["task"]), record) for record in records]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--eval", required=True, type=Path)
    parser.add_argument("--configs", required=True, type=Path)
    parser.add_argument("--artifacts", required=True, type=Path)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--result", required=True, type=Path)
    parser.add_argument("--manifest", type=Path, default=ROOT / "short-swe.json")
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    started = time.time()
    stats = {"taskset_retries": 0}
    records = run_all(
        args.eval,
        args.configs,
        args.output / "initial",
        ROOT,
        stats=stats,
    )
    validate_tasks(records, manifest)
    records = retry_infrastructure_failures(
        args.eval,
        records,
        manifest,
        args.artifacts,
        args.commit,
        args.output,
        stats,
    )
    validate_tasks(records, manifest)
    validate_complete(records)
    args.result.parent.mkdir(parents=True, exist_ok=True)
    args.result.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "started_at": started,
                "finished_at": time.time(),
                "taskset_retries": stats["taskset_retries"],
                "tasks": records,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
