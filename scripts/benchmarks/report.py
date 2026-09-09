from __future__ import annotations

import hashlib
import json
import statistics
from dataclasses import dataclass

from schema import Metric, Observation, Report

MARKER = "<!-- prime-agent-benchmark:v1 -->"


def fingerprint(report: Report) -> str:
    fields = {
        "repository",
        "head_repository",
        "base_sha",
        "head_sha",
        "harness_sha",
        "model",
        "price",
        "config",
    }
    data = json.dumps(report.model_dump(include=fields), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(data.encode()).hexdigest()


@dataclass(frozen=True)
class Definition:
    key: Metric
    title: str
    scale: float
    unit: str
    absolute: float
    relative: float
    better: str
    worse: str


METRICS = (
    Definition("cold", "Cold startup", 1000, "ms", 0.1, 0.05, "faster", "slower"),
    Definition("warm", "Warm startup", 1000, "ms", 0.1, 0.05, "faster", "slower"),
    Definition("ttft", "TTFT", 1000, "ms", 0.1, 0.1, "faster", "slower"),
    Definition("install", "Installation", 1, "s", 1, 0.05, "faster", "slower"),
    Definition("bundle", "Compressed release artifacts", 1e-6, "MB", 65536, 0.005, "smaller", "larger"),
    Definition("disk", "Installed footprint", 1e-6, "MB", 1048576, 0.01, "smaller", "larger"),
    Definition("rss", "Idle memory, summed RSS", 1e-6, "MB", 10485760, 0.05, "less memory", "more memory"),
)


def escape(text: str) -> str:
    escaped = (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("|", "&#124;")
        .replace("`", "&#96;")
        .replace("\r", " ")
        .replace("\n", " ")
    )
    for character in ("\\", "[", "]", "(", ")", "*", "_", "!"):
        escaped = escaped.replace(character, f"\\{character}")
    return escaped


def values(samples: list[Observation]) -> list[float]:
    return [s.value for s in samples if s.value is not None]


def spread(numbers: list[float]) -> float:
    if len(numbers) < 4:
        return max(numbers) - min(numbers) if numbers else 0
    q1, _, q3 = statistics.quantiles(numbers, n=4, method="inclusive")
    return q3 - q1


def dispersion(samples: list[Observation], definition: Definition) -> str:
    numbers = values(samples)
    if len(numbers) < 2:
        return "—"
    kind = "IQR" if len(numbers) >= 4 else "range"
    return f"{kind} {number(spread(numbers), definition)} {definition.unit}"


def number(value: float, definition: Definition, signed: bool = False) -> str:
    scaled = value * definition.scale
    precision = 1 if definition.unit == "ms" else 2
    if scaled and abs(scaled) < 10 ** (-precision):
        return f"{scaled:+.2g}" if signed else f"{scaled:.2g}"
    return f"{scaled:+,.{precision}f}" if signed else f"{scaled:,.{precision}f}"


def comparison(
    definition: Definition, baseline: list[Observation], candidate: list[Observation], expected: int
) -> tuple[str, str, str, str, str]:
    left, right = values(baseline), values(candidate)
    main = statistics.median(left) if left else None
    head = statistics.median(right) if right else None
    main_text = "—" if main is None else f"{number(main, definition)} {definition.unit}"
    head_text = "—" if head is None else f"{number(head, definition)} {definition.unit}"
    if main is None or head is None:
        return main_text, head_text, "—", "N/A", "unavailable"
    delta = head - main
    percentage = f"{delta / main * 100:+.2f}%" if main else "N/A"
    if len(left) != expected or len(right) != expected:
        return (
            main_text,
            head_text,
            f"— {number(delta, definition, True)} {definition.unit}",
            percentage,
            "incomplete",
        )
    threshold = max(definition.absolute, main * definition.relative, spread(left), spread(right))
    signal, outcome = "≈", "no clear change"
    if abs(delta) > threshold:
        signal, outcome = ("↑", definition.worse) if delta > 0 else ("↓", definition.better)
    change = f"{signal} {number(delta, definition, True)} {definition.unit}"
    if signal == "↑":
        change, outcome = f"**{change}**", f"**{outcome}**"
    return main_text, head_text, change, percentage, outcome


def render(report: Report) -> str:
    run_url = f"https://github.com/{report.repository}/actions/runs/{report.run_id}"
    lines = [
        MARKER,
        f"<!-- run:{report.run_id}:{report.attempt} head:{report.head_sha} -->",
        f"<!-- comparison:{fingerprint(report)} status:{report.status} -->",
        f"### Prime Agent performance — {report.status}",
        "",
        f"PR `{report.head_sha[:8]}` compared with main `{report.base_sha[:8]}`.",
        *(
            ["Waiting for contributor vouch before credentials or sandboxes are allocated.", ""]
            if report.status == "pending-trust"
            else []
        ),
        "↓ improved · ↑ regressed · ≈ no clear change · — unavailable",
        "",
        "| Metric | Main | This PR | Change | Change % | Result |",
        "| --- | ---: | ---: | ---: | ---: | --- |",
    ]
    for definition in METRICS:
        expected = report.config.install_trials if definition.key == "install" else report.config.trials
        if definition.key in ("bundle", "disk"):
            expected = 1
        cells = comparison(
            definition,
            report.main.metrics.get(definition.key, []),
            report.pr_head.metrics.get(definition.key, []),
            expected,
        )
        lines.append(f"| {definition.title} | {' | '.join(cells)} |")
    compute = sum(s.estimated_usd for s in report.sandboxes)
    usage = report.inference
    cost = compute + usage.estimated_usd
    cost_text = (
        f"**Run cost: ~${cost:.4f}** — sandbox ~${compute:.4f}; inference ~${usage.estimated_usd:.4f}."
        if report.sandboxes
        else "Cost pending or unavailable; sandbox usage has not been collected."
    )
    result_link = (
        f"[Run, logs, and downloadable raw results]({run_url})"
        if report.pr
        else "Local run; raw results are stored beside this report."
    )
    lines.extend(
        [
            "",
            cost_text,
            f"Inference: {usage.prompts} prompts, {usage.responses} recorded responses, "
            f"{usage.input_tokens:,} input / {usage.output_tokens:,} output tokens. "
            f"{usage.incomplete_prompts} prompts lack complete usage.",
            result_link,
            "",
            "<details><summary>Methodology and samples</summary>",
            "",
            f"Main resolved at {report.started_at.isoformat()}. Harness `{report.harness_sha[:8]}`.",
            f"Model: {escape(report.model)}; effort: {report.config.effort}; direct Pinference; "
            f"output limit {report.config.max_output_tokens:,} tokens.",
            f"Linux x64, {report.config.cpu_cores:g} vCPU, {report.config.memory_gb:g} GB RAM, "
            f"{report.config.disk_gb:g} GB disk; region {escape(report.config.region)}.",
            f"Image: `{escape(report.config.image)}`.",
            "Stock tools, skills, daemon, and Python bootstrap enabled; fresh homes and a fixed Git fixture.",
            "Medians shown. Arrows use provisional thresholds and IQR, not a significance test.",
            "Cold means stopped Prime processes; OS and provider caches are not flushed.",
            "TTFT includes model, network, and rendering. Installation excludes build/setup time.",
            "Installer tarballs use loopback; npm/Python downloads use the network with fresh caches.",
            "Artifact size counts release tarballs; footprint after first use includes registry packages.",
            "MB is decimal. Summed RSS can double-count shared pages; PSS is recorded when available.",
            "Provisioning, setup, and build durations are recorded separately in the raw results.",
            "Costs use duration and token usage at catalog rates; retries without usage may be missing.",
            f"Budget target: ${report.config.budget_usd:g}; not a billing cap. Checks are informational.",
            "",
            "| Metric | Main successful/attempted | PR successful/attempted | Main spread | PR spread |",
            "| --- | ---: | ---: | ---: | ---: |",
        ]
    )
    for definition in METRICS:
        left = report.main.metrics.get(definition.key, [])
        right = report.pr_head.metrics.get(definition.key, [])
        lines.append(
            f"| {definition.title} | {len(values(left))}/{len(left)} | {len(values(right))}/{len(right)} | "
            f"{dispersion(left, definition)} | {dispersion(right, definition)} |"
        )
    errors = list(report.errors)
    for name, side in (("main", report.main), ("PR", report.pr_head)):
        if side.error:
            errors.append(f"{name}: {side.error}")
        errors.extend(
            f"{name} {metric} trial {sample.trial}: {sample.error}"
            for metric, samples in side.metrics.items()
            for sample in samples
            if sample.error
        )
    if errors:
        lines.extend(["", "Failures:", ""] + [f"- {escape(error)}" for error in errors[:30]])
    lines.extend(["", "</details>", ""])
    return "\n".join(lines)
