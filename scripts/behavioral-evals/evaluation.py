from __future__ import annotations

import hashlib
import json
from typing import Annotated, Literal
from urllib.parse import quote, urlsplit

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

TASK_COUNT = 28
RESOLVED_LOSS_LIMIT = 5
MODEL_TIMEOUT_LIMIT = 3
RATIO_LIMIT = 2.0

SHA = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{40}$")]
Fingerprint = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
Repository = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")]
Name = Annotated[str, StringConstraints(min_length=1, max_length=200, pattern=r"^\S(?:.*\S)?$")]
TaskId = Annotated[
    str,
    StringConstraints(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$"),
]
Count = Annotated[int, Field(ge=0, le=10**15)]
Seconds = Annotated[float, Field(ge=0, le=10**15, allow_inf_nan=False)]
FactName = Annotated[
    str,
    StringConstraints(pattern=r"^[a-z][a-z0-9_]{0,63}$"),
]
SystemicFailure = Literal["install", "launch", "acp", "cpython", "trace_integrity", "cleanup"]
FindingCode = Literal[
    "resolved_losses",
    "model_timeouts",
    "output_tokens",
    "e2e_seconds",
    "systemic_install_failure",
    "systemic_launch_failure",
    "systemic_acp_failure",
    "systemic_cpython_failure",
    "systemic_trace_integrity_failure",
    "systemic_cleanup_failure",
]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, strict=True)


class Identity(StrictModel):
    repository: Repository
    pr: Annotated[int, Field(ge=1)]
    head_sha: SHA
    harness_sha: SHA
    manifest_fingerprint: Fingerprint
    evaluator_contract_fingerprint: Fingerprint
    model: Name
    autonomous: Literal[False]


class TaskResult(StrictModel):
    task_id: TaskId
    resolved: bool
    provider_output_tokens: Count
    e2e_seconds: Seconds
    model_calls: Count
    tool_calls: Count
    model_timeout: bool
    infrastructure_error: bool
    retries: Count = 0
    trace_fact_counts: dict[FactName, Count] = Field(max_length=100)


class CandidateResult(StrictModel):
    schema_version: Literal[1] = 1
    kind: Literal["candidate"] = "candidate"
    identity: Identity
    tasks: list[TaskResult] = Field(min_length=TASK_COUNT, max_length=TASK_COUNT)
    run_retries: Count = 0
    systemic_failures: list[SystemicFailure] = Field(default_factory=list, max_length=6)

    @model_validator(mode="after")
    def validate_unique_values(self) -> CandidateResult:
        _require_unique_tasks(self.tasks)
        if len(set(self.systemic_failures)) != len(self.systemic_failures):
            raise ValueError("systemic_failures must not contain duplicates")
        return self


class BaselineResult(StrictModel):
    schema_version: Literal[1] = 1
    kind: Literal["baseline"] = "baseline"
    source_candidate_fingerprint: Fingerprint
    identity: Identity
    tasks: list[TaskResult] = Field(min_length=TASK_COUNT, max_length=TASK_COUNT)
    run_retries: Count = 0

    @model_validator(mode="after")
    def validate_unique_tasks(self) -> BaselineResult:
        _require_unique_tasks(self.tasks)
        return self


class FindingConfirmation(StrictModel):
    code: FindingCode
    confirmed: bool
    task_ids: list[TaskId] = Field(min_length=1, max_length=TASK_COUNT)
    note: Annotated[str, Field(min_length=1, max_length=500)]

    @model_validator(mode="after")
    def validate_unique_tasks(self) -> FindingConfirmation:
        if len(set(self.task_ids)) != len(self.task_ids):
            raise ValueError("confirmation task_ids must not contain duplicates")
        return self


class ConfirmationRecord(StrictModel):
    schema_version: Literal[1] = 1
    kind: Literal["confirmation"] = "confirmation"
    candidate_fingerprint: Fingerprint
    findings: list[FindingConfirmation] = Field(min_length=1, max_length=10)

    @model_validator(mode="after")
    def validate_unique_findings(self) -> ConfirmationRecord:
        codes = [finding.code for finding in self.findings]
        if len(set(codes)) != len(codes):
            raise ValueError("confirmation findings must not contain duplicate codes")
        return self


class Aggregate(StrictModel):
    resolved: Count
    provider_output_tokens: Count
    e2e_seconds: Seconds
    model_calls: Count
    tool_calls: Count
    model_timeouts: Count
    infrastructure_errors: Count
    retries: Count
    trace_findings: Count


class Finding(StrictModel):
    code: FindingCode
    summary: str
    task_ids: list[TaskId] = Field(default_factory=list)


class Comparison(StrictModel):
    mode: Literal["seed", "comparison"]
    status: Literal["seed", "pass", "needs_confirmation", "fail"]
    baseline: Aggregate | None
    candidate: Aggregate
    resolved_delta: int | None
    output_token_ratio: float | None
    e2e_ratio: float | None
    findings: list[Finding]
    confirmation_applied: bool = False


def _require_unique_tasks(tasks: list[TaskResult]) -> None:
    task_ids = [task.task_id for task in tasks]
    if len(set(task_ids)) != len(task_ids):
        raise ValueError("task_id values must be unique")


def candidate_fingerprint(candidate: CandidateResult) -> str:
    data = candidate.model_dump(mode="json")
    encoded = json.dumps(data, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def make_baseline(candidate: CandidateResult) -> BaselineResult:
    return BaselineResult(
        source_candidate_fingerprint=candidate_fingerprint(candidate),
        identity=candidate.identity.model_copy(deep=True),
        tasks=[task.model_copy(deep=True) for task in candidate.tasks],
        run_retries=candidate.run_retries,
    )


def aggregate(tasks: list[TaskResult], run_retries: int = 0) -> Aggregate:
    return Aggregate(
        resolved=sum(task.resolved for task in tasks),
        provider_output_tokens=sum(task.provider_output_tokens for task in tasks),
        e2e_seconds=sum(task.e2e_seconds for task in tasks),
        model_calls=sum(task.model_calls for task in tasks),
        tool_calls=sum(task.tool_calls for task in tasks),
        model_timeouts=sum(task.model_timeout for task in tasks),
        infrastructure_errors=sum(task.infrastructure_error for task in tasks),
        retries=run_retries + sum(task.retries for task in tasks),
        trace_findings=sum(sum(task.trace_fact_counts.values()) for task in tasks),
    )


def _ratio(candidate: float, baseline: float) -> float | None:
    return candidate / baseline if baseline > 0 else None


def _task_ids(tasks: list[TaskResult], field: str) -> list[str]:
    return [task.task_id for task in tasks if getattr(task, field)]


def _require_comparable(candidate: CandidateResult, baseline: BaselineResult) -> None:
    candidate_identity = candidate.identity
    baseline_identity = baseline.identity
    fields = (
        "repository",
        "manifest_fingerprint",
        "evaluator_contract_fingerprint",
        "model",
        "autonomous",
    )
    mismatches = [
        field for field in fields if getattr(candidate_identity, field) != getattr(baseline_identity, field)
    ]
    if mismatches:
        raise ValueError("baseline identity mismatch: " + ", ".join(mismatches))
    candidate_tasks = {task.task_id for task in candidate.tasks}
    baseline_tasks = {task.task_id for task in baseline.tasks}
    if candidate_tasks != baseline_tasks:
        raise ValueError("baseline and candidate task_id values must match")


def _findings(
    candidate: CandidateResult,
    baseline_result: BaselineResult,
    current: Aggregate,
    baseline: Aggregate,
    resolved_delta: int,
    token_ratio: float | None,
    e2e_ratio: float | None,
) -> list[Finding]:
    findings: list[Finding] = []
    prior_tasks = {task.task_id: task for task in baseline_result.tasks}
    all_task_ids = sorted(prior_tasks)
    if -resolved_delta >= RESOLVED_LOSS_LIMIT:
        lost = sorted(
            task.task_id for task in candidate.tasks if prior_tasks[task.task_id].resolved != task.resolved
        )
        findings.append(
            Finding(
                code="resolved_losses",
                summary=f"Net resolved tasks decreased by {-resolved_delta}.",
                task_ids=lost,
            )
        )
    additional_timeouts = current.model_timeouts - baseline.model_timeouts
    if additional_timeouts >= MODEL_TIMEOUT_LIMIT:
        new_timeouts = sorted(
            task.task_id
            for task in candidate.tasks
            if task.model_timeout != prior_tasks[task.task_id].model_timeout
        )
        findings.append(
            Finding(
                code="model_timeouts",
                summary=f"Model timeouts increased by {additional_timeouts}.",
                task_ids=new_timeouts,
            )
        )
    no_resolution_improvement = resolved_delta <= 0
    if token_ratio is not None and token_ratio >= RATIO_LIMIT and no_resolution_improvement:
        findings.append(
            Finding(
                code="output_tokens",
                summary=f"Provider output tokens were {token_ratio:.2f}x baseline without more resolutions.",
                task_ids=all_task_ids,
            )
        )
    if e2e_ratio is not None and e2e_ratio >= RATIO_LIMIT and no_resolution_improvement:
        findings.append(
            Finding(
                code="e2e_seconds",
                summary=f"End-to-end time was {e2e_ratio:.2f}x baseline without more resolutions.",
                task_ids=all_task_ids,
            )
        )
    infrastructure_tasks = _task_ids(candidate.tasks, "infrastructure_error")
    for failure in candidate.systemic_failures:
        code = f"systemic_{failure}_failure"
        findings.append(
            Finding(
                code=code,
                summary=f"The run recorded a systemic {failure.replace('_', '-')} failure.",
                task_ids=infrastructure_tasks or all_task_ids,
            )
        )
    return findings


def compare(
    candidate: CandidateResult,
    baseline: BaselineResult | None = None,
    confirmation: ConfirmationRecord | None = None,
) -> Comparison:
    current = aggregate(candidate.tasks, candidate.run_retries)
    if baseline is None:
        return Comparison(
            mode="seed",
            status="seed",
            baseline=None,
            candidate=current,
            resolved_delta=None,
            output_token_ratio=None,
            e2e_ratio=None,
            findings=[],
        )

    _require_comparable(candidate, baseline)
    prior = aggregate(baseline.tasks, baseline.run_retries)
    resolved_delta = current.resolved - prior.resolved
    token_ratio = _ratio(current.provider_output_tokens, prior.provider_output_tokens)
    e2e_ratio = _ratio(current.e2e_seconds, prior.e2e_seconds)
    findings = _findings(
        candidate,
        baseline,
        current,
        prior,
        resolved_delta,
        token_ratio,
        e2e_ratio,
    )
    status: Literal["pass", "needs_confirmation", "fail"] = "pass" if not findings else "needs_confirmation"
    confirmation_applied = False
    if confirmation is not None:
        if confirmation.candidate_fingerprint != candidate_fingerprint(candidate):
            raise ValueError("confirmation does not match the candidate result")
        candidate_task_ids = {task.task_id for task in candidate.tasks}
        if any(not set(item.task_ids) <= candidate_task_ids for item in confirmation.findings):
            raise ValueError("confirmation references an unknown task_id")
        findings_by_code = {finding.code: finding for finding in findings}
        confirmation_codes = {item.code for item in confirmation.findings}
        if not confirmation_codes <= findings_by_code.keys():
            raise ValueError("confirmation references a threshold that did not cross")
        for item in confirmation.findings:
            evidence_tasks = set(findings_by_code[item.code].task_ids)
            if set(item.task_ids) != evidence_tasks:
                raise ValueError("confirmation task_ids must match the threshold evidence")
        finding_codes = set(findings_by_code)
        confirmation_applied = True
        confirmed = {item.code for item in confirmation.findings if item.confirmed}
        unresolved = finding_codes - confirmation_codes
        if confirmed:
            status = "fail"
        elif not unresolved:
            status = "pass"

    return Comparison(
        mode="comparison",
        status=status,
        baseline=prior,
        candidate=current,
        resolved_delta=resolved_delta,
        output_token_ratio=token_ratio,
        e2e_ratio=e2e_ratio,
        findings=findings,
        confirmation_applied=confirmation_applied,
    )


def _escape(text: str) -> str:
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


def _number(value: float) -> str:
    if isinstance(value, int):
        return f"{value:,}"
    return f"{value:,.1f}"


def _change(value: float | None, suffix: str = "") -> str:
    if value is None:
        return "n/a"
    sign = "+" if value > 0 else ""
    return f"{sign}{_number(value)}{suffix}"


def render_markdown(
    candidate: CandidateResult,
    comparison: Comparison,
    artifacts_url: str,
) -> str:
    parsed_url = urlsplit(artifacts_url)
    if (
        parsed_url.scheme != "https"
        or not parsed_url.netloc
        or any(character in artifacts_url for character in "\r\n")
    ):
        raise ValueError("artifacts_url must be an absolute HTTPS URL")
    safe_url = quote(artifacts_url, safe="https:/?&=#%")
    if comparison.candidate != aggregate(candidate.tasks, candidate.run_retries):
        raise ValueError("comparison does not match the candidate result")
    baseline = comparison.baseline
    current = comparison.candidate
    baseline_values = {
        "resolution": "n/a" if baseline is None else f"{baseline.resolved}/{TASK_COUNT}",
        "tokens": "n/a" if baseline is None else _number(baseline.provider_output_tokens),
        "e2e": "n/a" if baseline is None else f"{_number(baseline.e2e_seconds)} s",
        "timeouts": "n/a" if baseline is None else _number(baseline.model_timeouts),
        "retries": "n/a" if baseline is None else _number(baseline.retries),
        "trace": "n/a" if baseline is None else _number(baseline.trace_findings),
    }
    resolved_change = comparison.resolved_delta
    token_change = (
        None if baseline is None else current.provider_output_tokens - baseline.provider_output_tokens
    )
    e2e_change = None if baseline is None else current.e2e_seconds - baseline.e2e_seconds
    timeout_change = None if baseline is None else current.model_timeouts - baseline.model_timeouts
    retry_change = None if baseline is None else current.retries - baseline.retries
    trace_change = None if baseline is None else current.trace_findings - baseline.trace_findings
    lines = [
        "### Behavioral evaluation",
        "",
        f"Status: **{comparison.status.replace('_', ' ')}**",
        (
            f"{_escape(candidate.identity.repository)} PR #{candidate.identity.pr}, "
            f"model {_escape(candidate.identity.model)}."
        ),
        "",
        "| Metric | Baseline | Candidate | Change |",
        "| --- | ---: | ---: | ---: |",
        (
            f"| Resolution | {baseline_values['resolution']} | {current.resolved}/{TASK_COUNT} | "
            f"{_change(resolved_change)} |"
        ),
        (
            f"| Provider output tokens | {baseline_values['tokens']} | "
            f"{_number(current.provider_output_tokens)} | {_change(token_change)} |"
        ),
        (
            f"| E2E | {baseline_values['e2e']} | {_number(current.e2e_seconds)} s | "
            f"{_change(e2e_change, ' s')} |"
        ),
        (
            f"| Model timeouts | {baseline_values['timeouts']} | {_number(current.model_timeouts)} | "
            f"{_change(timeout_change)} |"
        ),
        (
            f"| Infrastructure retries | {baseline_values['retries']} | {_number(current.retries)} | "
            f"{_change(retry_change)} |"
        ),
        (
            f"| Trace findings | {baseline_values['trace']} | {_number(current.trace_findings)} | "
            f"{_change(trace_change)} |"
        ),
        "",
    ]
    if comparison.mode == "seed":
        lines.append("No durable baseline exists. This run seeds it and does not fail the evaluation.")
    elif comparison.findings:
        lines.extend(["Threshold findings:", ""])
        lines.extend(f"- {_escape(finding.summary)}" for finding in comparison.findings)
    else:
        lines.append("No drastic threshold crossed.")
    lines.extend(
        [
            "",
            "Smaller changes are treated as expected run-to-run noise, not wins or regressions.",
            f"[Artifacts]({safe_url})",
            "",
        ]
    )
    return "\n".join(lines)
