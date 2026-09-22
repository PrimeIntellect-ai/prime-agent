#!/usr/bin/env python3
"""Validate and render the paired Short SWE release check."""

from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from pathlib import Path

MARKER = "<!-- prime-agent-behavioral-eval:v1 -->"
TASK_COUNT = 28
TASKSET_SIZES = {"swebench-verified": 15, "swebench-pro": 8, "scaleswe": 5}
RESOLVED_LOSS_LIMIT = 5
MODEL_FAILURE_LIMIT = 3
RATIO_LIMIT = 2.0
COLOR_THRESHOLD = 0.2
TASKSET_LABELS = {
    "swebench-verified": "SWE-bench Verified",
    "swebench-pro": "SWE-bench Pro",
    "scaleswe": "ScaleSWE",
}
HARNESS_LABELS = {
    "pi-coding-harness": "Pi coding harness",
    "codex": "Codex",
    "claude-code": "Claude Code",
    "swe-agent": "SWE Agent",
    "bash-edit": "Bash Edit",
}
BASELINES_PATH = Path(__file__).resolve().parent / "harness-baselines.json"
BASELINE_FIELDS = (
    "resolved",
    "model_failures",
    "uncached_input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "e2e_seconds",
)


def aggregate(tasks: list[dict]) -> dict:
    fields = ("uncached_input_tokens", "cached_input_tokens", "output_tokens", "model_calls")
    if len(tasks) != TASK_COUNT:
        raise ValueError("a result side must contain 28 tasks")
    for task in tasks:
        if (
            not isinstance(task.get("resolved"), bool)
            or not isinstance(task.get("model_failure"), bool)
            or task["resolved"]
            and task["model_failure"]
        ):
            raise ValueError("invalid outcome value")
        for field in fields:
            value = task.get(field)
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                raise ValueError(f"invalid {field}")
        elapsed = task.get("e2e_seconds")
        if (
            not isinstance(elapsed, (int, float))
            or isinstance(elapsed, bool)
            or not math.isfinite(elapsed)
            or elapsed < 0
        ):
            raise ValueError("invalid e2e_seconds")
    return {
        "tasks": len(tasks),
        "resolved": sum(task["resolved"] for task in tasks),
        "model_failures": sum(task["model_failure"] for task in tasks),
        **{field: sum(task[field] for task in tasks) for field in fields},
        "e2e_seconds": sum(task["e2e_seconds"] for task in tasks),
    }


def color(relative: float, regressed: bool) -> str:
    muted, vivid = ((170, 106, 101), (229, 72, 77)) if regressed else ((102, 129, 109), (31, 146, 78))
    intensity = min(abs(relative), 1.0)
    channels = (round(start + (end - start) * intensity) for start, end in zip(muted, vivid, strict=True))
    return "#" + "".join(f"{channel:02x}" for channel in channels)


def change(
    head: float, base: float, *, lower_is_better: bool = True, threshold: float = COLOR_THRESHOLD
) -> str:
    delta = head - base
    if delta == 0:
        return "≈ 0 (0.0%)"
    relative = delta / base if base else None
    style_change = relative if relative is not None else 1.0
    percentage = "n/a" if relative is None else f"{relative * 100:+.1f}%"
    text = f"{delta:+,.1f} ({percentage})" if isinstance(delta, float) else f"{delta:+,} ({percentage})"
    if abs(style_change) < threshold:
        return f"≈ {text}"
    regressed = delta > 0 if lower_is_better else delta < 0
    arrow = "↑" if delta > 0 else "↓"
    safe = f"{arrow} {text}".replace("%", r"\%")
    return rf"$`\textcolor{{{color(style_change, regressed)}}}{{\textsf{{{safe}}}}}`$"


def compare(base: dict, head: dict) -> list[str]:
    findings = []
    resolved_delta = head["resolved"] - base["resolved"]
    if resolved_delta <= -RESOLVED_LOSS_LIMIT:
        findings.append(f"Resolved tasks decreased by {-resolved_delta}.")
    additional_failures = head["model_failures"] - base["model_failures"]
    if additional_failures >= MODEL_FAILURE_LIMIT:
        findings.append(f"Model failures increased by {additional_failures}.")
    for field, label in (("output_tokens", "Output tokens"), ("e2e_seconds", "Cumulative task time")):
        ratio = head[field] / base[field] if base[field] > 0 else math.inf
        if resolved_delta <= 0 and (
            (base[field] == 0 and head[field] > 0) or (base[field] > 0 and ratio >= RATIO_LIMIT)
        ):
            findings.append(f"{label} reached {ratio:.2f}x base without more resolutions.")
    return findings


def grouped(tasks: list[dict]) -> dict[str, dict]:
    values = defaultdict(list)
    for task in tasks:
        values[task["taskset"]].append(task)
    return {name: aggregate_side(rows) for name, rows in values.items()}


def aggregate_side(tasks: list[dict]) -> dict:
    return {
        "tasks": len(tasks),
        "resolved": sum(task["resolved"] for task in tasks),
        "uncached_input_tokens": sum(task["uncached_input_tokens"] for task in tasks),
        "cached_input_tokens": sum(task["cached_input_tokens"] for task in tasks),
        "output_tokens": sum(task["output_tokens"] for task in tasks),
    }


def validate_result(result: dict, request: dict) -> tuple[dict, dict]:
    pinned = {
        "internal/glm-5.3-fast",
        "internal/deepseek-v4.1-flash",
    }
    if (
        result.get("schema_version") != 1
        or result.get("request") != request
        or result.get("model") not in pinned
    ):
        raise ValueError("result identity does not match the trusted request")
    sides = result.get("sides")
    if not isinstance(sides, dict) or set(sides) != {"base", "head"}:
        raise ValueError("paired result is incomplete")
    base, head = aggregate(sides["base"]), aggregate(sides["head"])
    base_ids = {(task["taskset"], task["task"]) for task in sides["base"]}
    head_ids = {(task["taskset"], task["task"]) for task in sides["head"]}
    if len(base_ids) != TASK_COUNT or base_ids != head_ids:
        raise ValueError("base and head task identities do not match")
    return base, head


def validate_baselines(document: dict) -> dict[str, dict]:
    """Validate a harness baselines document and return entries keyed by harness id."""
    if (
        not isinstance(document, dict)
        or document.get("schema_version") != 2
        or not isinstance(document.get("description"), str)
        or not document["description"]
        or not isinstance(document.get("model"), str)
        or not document["model"]
    ):
        raise ValueError("invalid harness baselines document")
    entries = document.get("baselines")
    if not isinstance(entries, list) or len(entries) != len(HARNESS_LABELS):
        raise ValueError("harness baselines must list every harness exactly once")
    validated: dict[str, dict] = {}
    seen: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict) or entry.get("harness") not in HARNESS_LABELS:
            raise ValueError("invalid harness baseline identity")
        harness = entry["harness"]
        if harness in seen:
            raise ValueError("duplicate harness baseline")
        seen.add(harness)
        tasksets = entry.get("tasksets")
        if not isinstance(tasksets, dict) or set(tasksets) != set(TASKSET_SIZES):
            raise ValueError(f"harness baseline for {harness} must cover every taskset")
        for ts_id, ts in tasksets.items():
            if not isinstance(ts, dict):
                raise ValueError(f"invalid taskset entry for {harness}/{ts_id}")
            if not isinstance(ts.get("measured"), bool):
                raise ValueError(f"invalid harness baseline measured for {harness}/{ts_id}")
            expected = TASKSET_SIZES[ts_id]
            if ts.get("tasks") != expected:
                raise ValueError(f"harness baseline {harness}/{ts_id} must list {expected} tasks")
            resolved = ts.get("resolved")
            if not isinstance(resolved, int) or isinstance(resolved, bool) or not 0 <= resolved <= expected:
                raise ValueError(f"invalid harness baseline resolved for {harness}/{ts_id}")
            for field in ("uncached_input_tokens", "cached_input_tokens", "output_tokens"):
                value = ts.get(field)
                if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                    raise ValueError(f"invalid harness baseline {field} for {harness}/{ts_id}")
        validated[harness] = entry
    return validated


def load_baselines(path: Path | None = None) -> dict[str, dict]:
    """Return measured harness baselines; they are context only, so every problem reads as unmeasured."""
    if path is None:
        path = BASELINES_PATH
    try:
        document = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    try:
        return validate_baselines(document)
    except (ValueError, TypeError, KeyError):
        return {}


def render_baselines(measured: dict[str, dict]) -> list[str]:
    """Render the static harness baselines; they are context only and never gate the verdict."""
    lines = [
        "",
        "#### Harness baselines (static reference)",
        "",
        "| Harness | SWE-bench Verified | SWE-bench Pro | ScaleSWE | Total |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    unmeasured = []
    for harness, label in HARNESS_LABELS.items():
        entry = measured.get(harness)
        if entry is None or not entry.get("tasksets"):
            unmeasured.append(label)
            lines.append(
                f"| {label} | ?/{TASKSET_SIZES['swebench-verified']} | "
                f"?/{TASKSET_SIZES['swebench-pro']} | "
                f"?/{TASKSET_SIZES['scaleswe']} | ?/{TASK_COUNT} |"
            )
        else:
            tasksets = entry["tasksets"]
            cells = []
            for ts_id in ("swebench-verified", "swebench-pro", "scaleswe"):
                ts = tasksets.get(ts_id)
                if ts and ts.get("measured"):
                    cells.append(f"{ts.get('resolved', 0)}/{ts['tasks']}")
                else:
                    cells.append(f"?/{ts['tasks']}" if ts else f"?/{TASKSET_SIZES[ts_id]}")
            total = sum(ts.get("resolved", 0) for ts in tasksets.values() if ts.get("measured"))
            total_tasks = sum(ts["tasks"] for ts in tasksets.values() if ts.get("measured"))
            if any(ts.get("measured") for ts in tasksets.values()):
                lines.append(f"| {label} | {' | '.join(cells)} | {total}/{total_tasks} |")
            else:
                unmeasured.append(label)
                lines.append(
                    f"| {label} | ?/{TASKSET_SIZES['swebench-verified']} | "
                    f"?/{TASKSET_SIZES['swebench-pro']} | "
                    f"?/{TASKSET_SIZES['scaleswe']} | ?/{TASK_COUNT} |"
                )
    lines.append("")
    if unmeasured:
        plural = "s" if len(unmeasured) > 1 else ""
        lines.append(f"Baseline{plural} not yet measured: {', '.join(unmeasured)}.")
    lines.append("Static reference only; harness baselines never gate the PR.")
    lines.extend(
        [
            "",
            "| Harness | Uncached input | Cached input | Output |",
            "| --- | ---: | ---: | ---: |",
        ]
    )
    for harness, label in HARNESS_LABELS.items():
        entry = measured.get(harness)
        if entry is None or not entry.get("tasksets"):
            lines.append(f"| {label} | ? | ? | ? |")
        else:
            tasksets = entry["tasksets"]
            uncached = sum(
                ts.get("uncached_input_tokens", 0) for ts in tasksets.values() if ts.get("measured")
            )
            cached = sum(ts.get("cached_input_tokens", 0) for ts in tasksets.values() if ts.get("measured"))
            output = sum(ts.get("output_tokens", 0) for ts in tasksets.values() if ts.get("measured"))
            if any(ts.get("measured") for ts in tasksets.values()):
                lines.append(f"| {label} | {uncached:,} | {cached:,} | {output:,} |")
            else:
                lines.append(f"| {label} | ? | ? | ? |")
    return lines


def render(result: dict, request: dict, evaluations: dict | None = None) -> tuple[str, str]:
    base, head = validate_result(result, request)
    findings = compare(base, head)
    verdict = "fail" if findings else "pass"
    run_url = f"https://github.com/{request['repository']}/actions/runs/{request['run_id']}"
    resolution_change = change(head["resolved"], base["resolved"], lower_is_better=False, threshold=0)
    failure_change = change(head["model_failures"], base["model_failures"], threshold=0)
    uncached_change = change(head["uncached_input_tokens"], base["uncached_input_tokens"])
    cached_change = change(head["cached_input_tokens"], base["cached_input_tokens"])
    output_change = change(head["output_tokens"], base["output_tokens"])
    elapsed_change = change(head["e2e_seconds"], base["e2e_seconds"])
    lines = [
        MARKER,
        f"<!-- head:{request['head_sha']} -->",
        f"### Behavioral evaluation — {verdict}",
        "",
        f"PR head `{request['head_sha'][:8]}` compared with exact base `{request['base_sha'][:8]}`.",
        f"Model `{result['model']}`. Inference cost: **$0**.",
        "Time is summed across task traces; concurrent tasks overlap in wall-clock time.",
        "",
        "| Metric | Exact base | PR head | Change |",
        "| --- | ---: | ---: | ---: |",
        f"| Resolution | {base['resolved']}/{TASK_COUNT} | {head['resolved']}/{TASK_COUNT} | "
        f"{resolution_change} |",
        f"| Model failures | {base['model_failures']} | {head['model_failures']} | {failure_change} |",
        f"| Uncached input tokens | {base['uncached_input_tokens']:,} | "
        f"{head['uncached_input_tokens']:,} | {uncached_change} |",
        f"| Cached input tokens | {base['cached_input_tokens']:,} | "
        f"{head['cached_input_tokens']:,} | {cached_change} |",
        f"| Output tokens | {base['output_tokens']:,} | {head['output_tokens']:,} | {output_change} |",
        f"| Cumulative task time | {base['e2e_seconds']:,.1f} s | {head['e2e_seconds']:,.1f} s | "
        f"{elapsed_change} |",
        "",
        "#### Results by taskset",
        "",
        "| Taskset | Side | Resolution | Uncached input | Cached input | Output |",
        "| --- | --- | ---: | ---: | ---: | ---: |",
    ]
    tasksets = {side: grouped(result["sides"][side]) for side in ("base", "head")}
    if tasksets["base"].keys() != tasksets["head"].keys():
        raise ValueError("base and head tasksets do not match")
    for name in TASKSET_LABELS:
        for side, label in (("base", "Exact base"), ("head", "PR head")):
            value = tasksets[side][name]
            lines.append(
                f"| {TASKSET_LABELS[name]} | {label} | {value['resolved']}/{value['tasks']} | "
                f"{value['uncached_input_tokens']:,} | {value['cached_input_tokens']:,} | "
                f"{value['output_tokens']:,} |"
            )
    lines.extend(render_baselines(load_baselines()))
    lines.extend(["", "**Threshold findings:**" if findings else "No drastic threshold crossed.", ""])
    lines.extend(f"- {finding}" for finding in findings)
    lines.append(f"[Workflow run]({run_url})")
    if evaluations:
        lines.extend(["", "**Hosted evaluations (Prime Evals):**", ""])
        for key in sorted(evaluations):
            record = evaluations[key]
            evaluation_id = record.get("evaluation_id", "")
            viewer = f"https://app.primeintellect.ai/dashboard/evaluations/{evaluation_id}"
            lines.append(f"- {key}: [{record.get('name', evaluation_id)}]({viewer})")
        lines.append("")
    return "\n".join(lines), verdict


def render_failure(request: dict) -> str:
    run_url = f"https://github.com/{request['repository']}/actions/runs/{request['run_id']}"
    return "\n".join(
        [
            MARKER,
            f"<!-- head:{request['head_sha']} -->",
            "### Behavioral evaluation — failed",
            "",
            "The exact base/head comparison did not produce a complete validated result.",
            "Missing or malformed measurements are never treated as improvements.",
            "",
            f"[Run, logs, and artifacts]({run_url})",
            "",
        ]
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--result", required=True, type=Path)
    parser.add_argument("--markdown", required=True, type=Path)
    parser.add_argument("--verdict", required=True, type=Path)
    parser.add_argument("--evaluations", type=Path, default=None)
    args = parser.parse_args()
    request = json.loads(args.request.read_text())
    evaluations = None
    if args.evaluations and args.evaluations.exists():
        evaluations = json.loads(args.evaluations.read_text())
    try:
        markdown, verdict = render(json.loads(args.result.read_text()), request, evaluations)
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
        markdown, verdict = render_failure(request), "fail"
    args.markdown.parent.mkdir(parents=True, exist_ok=True)
    args.markdown.write_text(markdown)
    args.verdict.write_text(verdict + "\n")


if __name__ == "__main__":
    main()
