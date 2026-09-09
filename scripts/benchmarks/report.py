from __future__ import annotations

import hashlib
import json
import statistics
from dataclasses import dataclass

from schema import Metric, Observation, Report

MARKER = "<!-- prime-agent-benchmark:v1 -->"
PERFORMANCE_NOISE_FLOOR = 0.2


def fingerprint(report: Report) -> str:
    fields = {
        "repository",
        "head_repository",
        "base_sha",
        "head_sha",
        "harness_sha",
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
    Definition("cold", "Cold startup", 1000, "ms", 0.1, PERFORMANCE_NOISE_FLOOR, "faster", "slower"),
    Definition("warm", "Warm startup", 1000, "ms", 0.1, PERFORMANCE_NOISE_FLOOR, "faster", "slower"),
    Definition("install", "Installation", 1, "s", 1, PERFORMANCE_NOISE_FLOOR, "faster", "slower"),
    Definition("bundle", "Compressed release artifacts", 1e-6, "MB", 65536, 0.005, "smaller", "larger"),
    Definition("disk", "Installed footprint", 1e-6, "MB", 1048576, 0.01, "smaller", "larger"),
    Definition(
        "rss",
        "Idle memory, summed RSS",
        1e-6,
        "MB",
        10485760,
        PERFORMANCE_NOISE_FLOOR,
        "less memory",
        "more memory",
    ),
)
RUNTIME_METRICS = (
    Definition(
        "kernel_start",
        "Python kernel startup",
        1000,
        "ms",
        0.005,
        PERFORMANCE_NOISE_FLOOR,
        "faster",
        "slower",
    ),
    Definition(
        "kernel_exec",
        "Python cell round trip",
        1000,
        "ms",
        0.0001,
        PERFORMANCE_NOISE_FLOOR,
        "faster",
        "slower",
    ),
    Definition("bash", "Empty bash command", 1000, "ms", 0.001, PERFORMANCE_NOISE_FLOOR, "faster", "slower"),
    Definition(
        "git_status", "Bash git status", 1000, "ms", 0.001, PERFORMANCE_NOISE_FLOOR, "faster", "slower"
    ),
    Definition(
        "output", "Bash 32 KiB output", 1000, "ms", 0.001, PERFORMANCE_NOISE_FLOOR, "faster", "slower"
    ),
    Definition(
        "mixed", "35 cells / 9 shell calls", 1000, "ms", 0.005, PERFORMANCE_NOISE_FLOOR, "faster", "slower"
    ),
    Definition(
        "interrupt",
        "Python interrupt to done",
        1000,
        "ms",
        0.0005,
        PERFORMANCE_NOISE_FLOOR,
        "faster",
        "slower",
    ),
    Definition(
        "snapshot", "Python state snapshot", 1000, "ms", 0.001, PERFORMANCE_NOISE_FLOOR, "faster", "slower"
    ),
    Definition(
        "restore", "Python state restore", 1000, "ms", 0.001, PERFORMANCE_NOISE_FLOOR, "faster", "slower"
    ),
    Definition(
        "kernel_rss",
        "Python idle RSS",
        1e-6,
        "MB",
        1048576,
        PERFORMANCE_NOISE_FLOOR,
        "less memory",
        "more memory",
    ),
    Definition(
        "loaded_rss",
        "Python RSS after pandas workload",
        1e-6,
        "MB",
        1048576,
        PERFORMANCE_NOISE_FLOOR,
        "less memory",
        "more memory",
    ),
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
    precision = (
        3
        if definition.unit == "ms" and definition.absolute < 0.001
        else (1 if definition.unit == "ms" else 2)
    )
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
    for definition in (*METRICS, *RUNTIME_METRICS):
        if definition == RUNTIME_METRICS[0]:
            lines.extend(
                [
                    "",
                    "**Python runtime**",
                    "",
                    "| Metric | Main | This PR | Change | Change % | Result |",
                    "| --- | ---: | ---: | ---: | ---: | --- |",
                ]
            )
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
    cost_text = (
        f"**Sandbox cost: ~${compute:.4f}** — no inference calls."
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
            result_link,
            "",
            "<details><summary>Methodology and samples</summary>",
            "",
            f"Main resolved at {report.started_at.isoformat()}. Harness `{report.harness_sha[:8]}`.",
            f"Linux x64, {report.config.cpu_cores:g} vCPU, {report.config.memory_gb:g} GB RAM, "
            f"{report.config.disk_gb:g} GB disk; region {escape(report.config.region)}.",
            f"Image: `{escape(report.config.image)}`.",
            "Stock tools, skills, daemon, and Python bootstrap enabled; fresh homes and a fixed Git fixture.",
            "Onboarding is dismissed; the editor starts without a selected model or submitted prompt.",
            "Medians shown. Arrows require a 20% timing/memory change plus absolute floors and IQR.",
            "These practical noise floors are not a statistical significance test.",
            "Cold means stopped Prime processes; OS filesystem caches are not flushed.",
            "No model requests or credentials. Installation excludes build/setup time.",
            "Installer tarballs use loopback; npm/Python downloads use the network with fresh caches.",
            "Artifact size counts release tarballs; footprint after first use includes registry packages.",
            "MB is decimal. Summed RSS can double-count shared pages; PSS is recorded when available.",
            "Provisioning, setup, and build durations are recorded separately in the raw results.",
            "Kernel probes use the installed JSONL runtime, outside the TUI/TypeScript host.",
            "Per trial: 50 Python cells, 5 calls per shell case, and one 35-cell mix (9 git status calls).",
            "Cell/shell values are batch means; other runtime timings are single operations.",
            "State fixture: a 10,000-row × 8-column integer DataFrame and a 10,000-integer list.",
            "Restore runs in a fresh kernel, including pandas imports; kernel startup is excluded.",
            "Kernel RSS covers the isolated Python process; loaded RSS follows the pandas workload.",
            "Costs estimate full sandbox lifetimes at configured rates, including setup and build.",
            f"Budget target: ${report.config.budget_usd:g}; not a billing cap. Checks are informational.",
            "",
            "| Metric | Main successful/attempted | PR successful/attempted | Main spread | PR spread |",
            "| --- | ---: | ---: | ---: | ---: |",
        ]
    )
    for definition in (*METRICS, *RUNTIME_METRICS):
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
