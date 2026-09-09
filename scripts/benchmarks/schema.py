from __future__ import annotations

import math
from datetime import datetime
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

SHA = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{40}$")]
Repository = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")]
Metric = Literal["cold", "warm", "ttft", "install", "bundle", "disk", "rss", "pss"]
NonNegative = Annotated[float, Field(ge=0, le=1e15, allow_inf_nan=False)]
ROOT = Path(__file__).resolve().parent
UV_VERSION = "0.12.9"
PROMPT = "Reply with only the uppercase form of quartz."
ANSWER = "QUARTZ"
DEFAULT_MODEL = "openai/gpt-5.6-terra"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, strict=True)


class Config(StrictModel):
    image: Annotated[str, StringConstraints(pattern=r"^.+@sha256:[0-9a-f]{64}$")]
    region: str
    cpu_cores: Annotated[float, Field(gt=0, le=16)]
    memory_gb: Annotated[float, Field(gt=0, le=64)]
    disk_gb: Annotated[float, Field(gt=0, le=1000)]
    trials: Annotated[int, Field(ge=3, le=50)]
    install_trials: Annotated[int, Field(ge=1, le=10)]
    debounce_seconds: Annotated[int, Field(ge=0, le=300)]
    timeout_seconds: Annotated[int, Field(ge=60, le=3600)]
    ttl_minutes: Annotated[int, Field(ge=1, le=120)]
    budget_usd: Annotated[float, Field(gt=0, le=20)]
    max_output_tokens: Annotated[int, Field(ge=16, le=8192)]
    effort: Literal["off", "minimal", "low", "medium", "high", "xhigh", "max"]
    cpu_usd_per_hour: NonNegative
    memory_usd_per_gb_hour: NonNegative
    disk_usd_per_gb_hour: NonNegative

    @model_validator(mode="after")
    def validate_limits(self) -> Config:
        if self.ttl_minutes * 60 <= self.timeout_seconds:
            raise ValueError("Sandbox TTL must exceed the run timeout")
        return self

    @classmethod
    def load(cls, path: Path = ROOT / "config.json") -> Config:
        return cls.model_validate_json(path.read_text())

    def hourly_cost(self) -> float:
        return (
            self.cpu_cores * self.cpu_usd_per_hour
            + self.memory_gb * self.memory_usd_per_gb_hour
            + self.disk_gb * self.disk_usd_per_gb_hour
        )


class Price(StrictModel):
    input: NonNegative
    output: NonNegative
    cache_read: NonNegative | None = None
    cache_write: NonNegative | None = None


class Observation(StrictModel):
    trial: Annotated[int, Field(ge=0, le=100)]
    value: NonNegative | None = None
    error: Annotated[str, Field(max_length=500)] | None = None

    @model_validator(mode="after")
    def validate_outcome(self) -> Observation:
        if (self.value is None) == (self.error is None):
            raise ValueError("An observation must contain either a value or an error")
        return self


class ProcessMemory(StrictModel):
    pid: Annotated[int, Field(gt=0)]
    name: Annotated[str, Field(max_length=80)]
    rss: NonNegative
    pss: NonNegative | None = None


class InferenceUsage(StrictModel):
    prompts: Annotated[int, Field(ge=0)] = 0
    responses: Annotated[int, Field(ge=0)] = 0
    input_tokens: Annotated[int, Field(ge=0)] = 0
    output_tokens: Annotated[int, Field(ge=0)] = 0
    cached_tokens: Annotated[int, Field(ge=0)] = 0
    estimated_usd: NonNegative = 0
    incomplete_prompts: Annotated[int, Field(ge=0)] = 0


class Side(StrictModel):
    sha: SHA
    metrics: dict[Metric, list[Observation]] = Field(default_factory=dict)
    processes: list[ProcessMemory] = Field(default_factory=list, max_length=128)
    runtime: dict[str, str] = Field(default_factory=dict)
    timings: dict[Literal["provision", "setup", "build"], NonNegative] = Field(default_factory=dict)
    artifacts: dict[str, NonNegative] = Field(default_factory=dict)
    inference: InferenceUsage = Field(default_factory=InferenceUsage)
    error: Annotated[str, Field(max_length=500)] | None = None


class Request(StrictModel):
    repository: Repository
    source_repository: Repository
    sha: SHA
    harness_sha: SHA
    pr: Annotated[int, Field(ge=0)]
    run_id: Annotated[int, Field(ge=1)]
    attempt: Annotated[int, Field(ge=1)]
    role: Literal["main", "pr"]
    model: Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_./:-]{1,200}$")]
    config: Config
    price: Price


class Result(StrictModel):
    request: Request
    side: Side


class SandboxUsage(StrictModel):
    id: Annotated[str, StringConstraints(pattern=r"^[a-zA-Z0-9_-]+$")]
    role: Literal["main", "pr"]
    seconds: NonNegative
    estimated_usd: NonNegative
    deleted: bool


class Report(StrictModel):
    schema_version: Literal[1] = 1
    repository: Repository
    head_repository: Repository
    pr: Annotated[int, Field(ge=0)]
    run_id: Annotated[int, Field(ge=1)]
    attempt: Annotated[int, Field(ge=1)] = 1
    harness_sha: SHA
    base_sha: SHA
    head_sha: SHA
    started_at: datetime
    finished_at: datetime | None = None
    model: Annotated[str, Field(min_length=1, max_length=200)]
    price: Price
    config: Config
    status: Literal["pending-trust", "running", "completed", "partial", "failed", "canceled"] = "running"
    main: Side
    pr_head: Side
    inference: InferenceUsage = Field(default_factory=InferenceUsage)
    sandboxes: list[SandboxUsage] = Field(default_factory=list, max_length=2)
    errors: list[Annotated[str, Field(max_length=500)]] = Field(default_factory=list, max_length=30)

    @model_validator(mode="after")
    def validate_revisions(self) -> Report:
        if self.main.sha != self.base_sha or self.pr_head.sha != self.head_sha:
            raise ValueError("Result revisions do not match the request")
        for side in (self.main, self.pr_head):
            for metric, samples in side.metrics.items():
                expected = self.config.install_trials if metric == "install" else self.config.trials
                if metric in ("bundle", "disk"):
                    expected = 1
                if (
                    len(samples) > expected
                    or len({s.trial for s in samples}) != len(samples)
                    or any(sample.trial >= expected for sample in samples)
                ):
                    raise ValueError("Duplicate or excessive observations")
        return self


def write_json(path: Path, value: BaseModel) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(value.model_dump_json(indent=2) + "\n")
    temporary.replace(path)


def load_report(path: Path) -> Report:
    if path.stat().st_size > 2_000_000:
        raise ValueError("Report exceeds the size limit")
    return Report.model_validate_json(path.read_text())


def finite_number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) and value >= 0 else None
