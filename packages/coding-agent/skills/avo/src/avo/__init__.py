"""Universal AVO bridge over Prime Agent's host-authoritative state."""

from __future__ import annotations

import asyncio
from typing import Any

from rlm import host_request


def execution_contract() -> dict[str, Any]:
    return {
        "contract_version": 8,
        "forbid_runtime_introspection": True,
        "host_enforces_completion_and_canonical_delivery": True,
        "environments": ["general", "coding", "research"],
        "horizons": ["direct", "iterative", "long"],
        "authorities": ["host", "environment", "external", "model_opinion"],
        "verification_classes": [
            "external_factual",
            "deterministic_local",
            "coding",
            "research",
            "artifact",
            "subjective",
        ],
        "sequence": [
            "for coding only: run_coding_baseline before modifying the workspace",
            "add_candidate",
            (
                "run_evaluation for host-observed executable checks, bind every factual "
                "claim to external evidence, or record model_opinion"
            ),
            "complete_cycle",
            "inspect checkpoint and stop_gate",
        ],
        "calls": {
            "resume": "state = (await avo.get_state())['state']",
            "candidate": "await avo.add_candidate(candidate_dict)",
            "coding_baseline": "await avo.run_coding_baseline(command)",
            "host_evaluation": "await avo.run_evaluation(candidate_id, command)",
            "deterministic_evaluation": "await avo.verify_deterministic_result(candidate_id)",
            "artifact_evaluation": "await avo.verify_artifacts(candidate_id)",
            "external_evidence": (
                "await avo.bind_tool_result(candidate_id, claim_id, tool_call_id, exact_quote)"
            ),
            "external_source_fetch": "await avo.fetch_external_source(url)",
            "external_url_evidence": "await avo.bind_url(candidate_id, claim_id, url, exact_quote)",
            "opinion": "await avo.record_evaluation(model_opinion_dict)",
            "experiment": "await avo.record_experiment(experiment_dict)",
            "trial": (
                "await avo.run_trial(experiment_id, candidate_id, condition_id, seed)"
            ),
            "experiment_complete": "await avo.complete_experiment(experiment_id)",
            "cycle": "await avo.complete_cycle({'candidate_id': candidate_id})",
            "gate": "await avo.stop_gate()",
        },
        "canonical_rule": (
            "callers may issue only model_opinion; authoritative success requires an immutable "
            "receipt created from evidence the host directly observed"
        ),
        "factual_claim_rule": (
            "every factual claim must occur verbatim in the candidate payload and receive a "
            "host-classified supports receipt from a real external tool result"
        ),
        "coding_test_rule": (
            "candidate-created tests cannot certify themselves; before editing, execute a trusted "
            "direct test command that explicitly names an unchanged baseline file with "
            "run_coding_baseline, then require the exact same command and baseline identities "
            "to execute and pass after the candidate; mutable package scripts and output-printed "
            "filenames are not identity proof"
        ),
        "experiment_rule": (
            "record a structured prospective plan before trials; the host renders and hashes "
            "each candidate/condition/seed command, requires exact grid coverage, derives "
            "aggregate statistics, and alone issues champion promotion decisions"
        ),
    }


def _object(value: dict[str, Any], label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TypeError(f"{label} must be a dict, got {type(value).__name__}")
    return value


async def initialize(
    objective: str,
) -> dict[str, Any]:
    if not isinstance(objective, str) or not objective.strip():
        raise ValueError("objective must be a non-empty string")
    response = await host_request("avo.initialize", {"objective": objective})
    response["execution_contract"] = execution_contract()
    return response


async def configure(*, horizon: str) -> dict[str, Any]:
    if horizon not in {"iterative", "long"}:
        raise ValueError("model-facing configure may only escalate horizon to iterative or long")
    return await host_request("avo.configure", {"horizon": horizon})


async def get_state() -> dict[str, Any]:
    return await host_request("avo.get")


async def add_candidate(candidate: dict[str, Any]) -> dict[str, Any]:
    return await host_request("avo.candidate.add", {"candidate": _object(candidate, "candidate")})


async def record_evaluation(evaluation: dict[str, Any]) -> dict[str, Any]:
    evaluation = dict(_object(evaluation, "evaluation"))
    authority = evaluation.setdefault("authority", "model_opinion")
    if authority != "model_opinion":
        raise ValueError(
            "record_evaluation accepts only authority='model_opinion'; "
            "use run_evaluation for host-observed executable evidence"
        )
    return await host_request(
        "avo.evaluation.record",
        {"evaluation": evaluation},
    )


async def record_experiment(experiment: dict[str, Any]) -> dict[str, Any]:
    return await host_request(
        "avo.experiment.record",
        {"experiment": _object(experiment, "experiment")},
    )


async def record_trial(trial: dict[str, Any]) -> dict[str, Any]:
    return await host_request(
        "avo.trial.record",
        {"trial": _object(trial, "trial")},
    )


async def run_trial(
    experiment_id: str,
    candidate_id: str,
    condition_id: str,
    seed: str | int,
) -> dict[str, Any]:
    for value, label in (
        (experiment_id, "experiment_id"),
        (candidate_id, "candidate_id"),
        (condition_id, "condition_id"),
    ):
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{label} must be a non-empty string")
    if isinstance(seed, bool) or not isinstance(seed, (str, int)):
        raise ValueError("seed must be a non-empty string or integer")
    seed_value = str(seed)
    if not seed_value.strip():
        raise ValueError("seed must be a non-empty string or integer")
    return await host_request(
        "avo.trial.run",
        {
            "trial": {
                "experiment_id": experiment_id,
                "candidate_id": candidate_id,
                "condition_id": condition_id,
                "seed": seed_value,
            }
        },
    )


async def complete_experiment(experiment_id: str) -> dict[str, Any]:
    if not isinstance(experiment_id, str) or not experiment_id.strip():
        raise ValueError("experiment_id must be a non-empty string")
    return await host_request(
        "avo.experiment.complete",
        {"experiment_id": experiment_id},
    )


async def run_evaluation(candidate_id: str, command: str) -> dict[str, Any]:
    if not isinstance(candidate_id, str) or not candidate_id.strip():
        raise ValueError("candidate_id must be a non-empty string")
    if not isinstance(command, str) or not command.strip():
        raise ValueError("command must be a non-empty string")
    return await host_request(
        "avo.evaluation.run",
        {"candidate_id": candidate_id, "command": command},
    )


async def verify_deterministic_result(candidate_id: str) -> dict[str, Any]:
    if not isinstance(candidate_id, str) or not candidate_id.strip():
        raise ValueError("candidate_id must be a non-empty string")
    return await host_request(
        "avo.evaluation.deterministic",
        {"candidate_id": candidate_id},
    )


async def verify_artifacts(candidate_id: str) -> dict[str, Any]:
    if not isinstance(candidate_id, str) or not candidate_id.strip():
        raise ValueError("candidate_id must be a non-empty string")
    return await host_request(
        "avo.evaluation.artifacts",
        {"candidate_id": candidate_id},
    )


async def run_coding_baseline(command: str) -> dict[str, Any]:
    if not isinstance(command, str) or not command.strip():
        raise ValueError("command must be a non-empty string")
    return await host_request(
        "avo.verification.baseline.run",
        {"command": command},
    )


async def bind_tool_result(
    candidate_id: str,
    claim_id: str,
    tool_call_id: str,
    exact_quote: str,
) -> dict[str, Any]:
    for value, label in (
        (candidate_id, "candidate_id"),
        (claim_id, "claim_id"),
        (tool_call_id, "tool_call_id"),
        (exact_quote, "exact_quote"),
    ):
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{label} must be a non-empty string")
    return await host_request(
        "avo.evaluation.tool_result",
        {
            "candidate_id": candidate_id,
            "claim_id": claim_id,
            "tool_call_id": tool_call_id,
            "exact_quote": exact_quote,
        },
    )


async def fetch_external_source(url: str) -> dict[str, Any]:
    if not isinstance(url, str) or not url.strip():
        raise ValueError("url must be a non-empty string")
    return await host_request("avo.external.fetch", {"url": url})


async def bind_url(
    candidate_id: str,
    claim_id: str,
    url: str,
    exact_quote: str,
) -> dict[str, Any]:
    for value, label in (
        (candidate_id, "candidate_id"),
        (claim_id, "claim_id"),
        (url, "url"),
        (exact_quote, "exact_quote"),
    ):
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{label} must be a non-empty string")
    return await host_request(
        "avo.evaluation.url",
        {
            "candidate_id": candidate_id,
            "claim_id": claim_id,
            "url": url,
            "exact_quote": exact_quote,
        },
    )


async def collect_results() -> dict[str, Any]:
    return await host_request("avo.results.collect")


async def complete_cycle(
    cycle: dict[str, Any],
    *,
    await_supervisor: bool = True,
    timeout: float = 300,
    poll_interval: float = 2,
) -> dict[str, Any]:
    response = await host_request("avo.cycle.complete", {"cycle": _object(cycle, "cycle")})
    cycle_result = response.get("cycle")
    cycle_id = cycle_result.get("cycleId") if isinstance(cycle_result, dict) else None
    supervisor = response.get("supervisor")
    delivery = response.get("delivery")
    if (
        not await_supervisor
        or not isinstance(cycle_id, str)
        or not isinstance(supervisor, dict)
        or (isinstance(delivery, dict) and delivery.get("error"))
    ):
        return response
    loop = asyncio.get_running_loop()
    deadline = loop.time() + max(0.0, timeout)
    while loop.time() < deadline:
        collected = await collect_results()
        review = next(
            (
                item
                for item in collected.get("supervision", [])
                if isinstance(item, dict) and item.get("cycleId") == cycle_id
            ),
            None,
        )
        if review is not None:
            response["supervision"] = review
            return response
        await asyncio.sleep(poll_interval)
    raise TimeoutError(f"timed out waiting for AVO supervisor response for {cycle_id}")


async def checkpoint() -> dict[str, Any]:
    return await host_request("avo.checkpoint")


async def stop_gate() -> dict[str, Any]:
    return await host_request("avo.stop_gate")


async def complete() -> dict[str, Any]:
    return await host_request("avo.complete")


def nooa_backend_status() -> dict[str, Any]:
    return {
        "available": True,
        "backend": "host_persistent_nooa_bridge",
        "package": "nooa-memory==0.0.9",
        "runtime": "python3.13",
        "provider_unchanged": True,
        "automatic_before_turn_recall": True,
        "canonical_sync_owned_by_host": True,
    }


async def remember(memory: dict[str, Any]) -> dict[str, Any]:
    return await host_request("avo.memory.remember", {"memory": _object(memory, "memory")})


async def sync_nooa_memory() -> dict[str, Any]:
    return await host_request("avo.memory.sync")


async def recall(query: str, *, limit: int = 8) -> dict[str, Any]:
    return await host_request("avo.memory.recall", {"query": query, "limit": limit})


async def spontaneous_recall(query: str, *, limit: int = 5, max_chars: int = 2000) -> dict[str, Any]:
    return await host_request(
        "avo.memory.spontaneous",
        {"query": query, "limit": limit, "max_chars": max_chars},
    )


async def reflect_memory(trigger: str = "manual", *, cycle_id: str | None = None) -> dict[str, Any]:
    allowed = {
        "five_cycles",
        "supervisor_intervention",
        "candidate_acceptance",
        "post_task",
        "manual",
    }
    if trigger not in allowed:
        raise ValueError(f"trigger must be one of {sorted(allowed)}")
    return await host_request(
        "avo.memory.reflect",
        {"trigger": trigger, "cycle_id": cycle_id},
    )


__all__ = [
    "add_candidate",
    "bind_tool_result",
    "bind_url",
    "checkpoint",
    "collect_results",
    "complete",
    "complete_cycle",
    "complete_experiment",
    "configure",
    "execution_contract",
    "fetch_external_source",
    "get_state",
    "initialize",
    "nooa_backend_status",
    "recall",
    "record_evaluation",
    "record_experiment",
    "record_trial",
    "reflect_memory",
    "remember",
    "run_coding_baseline",
    "run_evaluation",
    "run_trial",
    "spontaneous_recall",
    "stop_gate",
    "sync_nooa_memory",
    "verify_artifacts",
    "verify_deterministic_result",
]
