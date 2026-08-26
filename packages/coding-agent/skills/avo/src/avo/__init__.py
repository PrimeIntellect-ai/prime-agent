"""Universal AVO bridge over Prime Agent's host-authoritative state."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from rlm import host_request


def execution_contract() -> dict[str, Any]:
    return {
        "contract_version": 3,
        "forbid_runtime_introspection": True,
        "environments": ["general", "coding", "research"],
        "horizons": ["direct", "iterative", "long"],
        "authorities": ["host", "environment", "external", "model_opinion"],
        "sequence": [
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
            "host_evaluation": "await avo.run_evaluation(candidate_id, command)",
            "external_evidence": (
                "await avo.bind_tool_result(candidate_id, claim_id, tool_call_id, exact_quote)"
            ),
            "opinion": "await avo.record_evaluation(model_opinion_dict)",
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
            "candidate-created tests cannot certify themselves without a trusted pre-task "
            "test suite or exact user acceptance command"
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


async def run_evaluation(candidate_id: str, command: str) -> dict[str, Any]:
    if not isinstance(candidate_id, str) or not candidate_id.strip():
        raise ValueError("candidate_id must be a non-empty string")
    if not isinstance(command, str) or not command.strip():
        raise ValueError("command must be a non-empty string")
    return await host_request(
        "avo.evaluation.run",
        {"candidate_id": candidate_id, "command": command},
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
    uv = shutil.which("uv")
    session_dir = os.environ.get("RLM_SESSION_DIR")
    if not uv:
        return {"available": False, "backend": "host_owned_fallback", "reason": "uv is unavailable"}
    if not session_dir:
        return {
            "available": False,
            "backend": "host_owned_fallback",
            "reason": "RLM_SESSION_DIR is unset",
        }
    return {
        "available": True,
        "backend": "nooa_memory_sidecar",
        "package": "nooa-memory==0.0.8",
        "runtime": "python3.13",
        "provider_unchanged": True,
    }


def _run_nooa_sidecar(command: str, payload: dict[str, Any]) -> dict[str, Any]:
    status = nooa_backend_status()
    if not status["available"]:
        return status
    path = Path(os.environ["RLM_SESSION_DIR"]) / "avo" / "nooa-memory.sqlite"
    path.parent.mkdir(parents=True, exist_ok=True)
    process = subprocess.run(
        [
            shutil.which("uv") or "uv",
            "run",
            "--no-project",
            "--python",
            "3.13",
            "--with",
            "nooa-memory==0.0.8",
            "python",
            str(Path(__file__).with_name("nooa_sidecar.py")),
            command,
            str(path),
        ],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        timeout=120,
        check=False,
    )
    if process.returncode != 0:
        reason = process.stderr.strip() or process.stdout.strip() or f"sidecar exited {process.returncode}"
        return {**status, "ok": False, "reason": reason[-2000:]}
    try:
        result = json.loads(process.stdout)
    except json.JSONDecodeError as error:
        return {**status, "ok": False, "reason": f"invalid sidecar JSON: {error}"}
    if not isinstance(result, dict):
        return {**status, "ok": False, "reason": "sidecar returned a non-object result"}
    return {**status, **result, "path": str(path)}


async def remember(memory: dict[str, Any], *, mirror_nooa: bool = True) -> dict[str, Any]:
    response = await host_request("avo.memory.remember", {"memory": _object(memory, "memory")})
    recorded = response.get("memory")
    response["nooa"] = (
        await asyncio.to_thread(_run_nooa_sidecar, "upsert", {"memory": recorded})
        if mirror_nooa and isinstance(recorded, dict)
        else nooa_backend_status()
    )
    return response


async def sync_nooa_memory() -> dict[str, Any]:
    state_response = await get_state()
    state = state_response.get("state")
    memories = state.get("memories", []) if isinstance(state, dict) else []
    return await asyncio.to_thread(
        _run_nooa_sidecar,
        "sync",
        {"memories": [memory for memory in memories if isinstance(memory, dict)]},
    )


async def recall(query: str, *, limit: int = 8) -> dict[str, Any]:
    fallback = await host_request("avo.memory.recall", {"query": query, "limit": limit})
    state_response = await get_state()
    state = state_response.get("state")
    memories = state.get("memories", []) if isinstance(state, dict) else []
    sync = await sync_nooa_memory()
    if not sync.get("ok"):
        fallback["nooa"] = sync
        return fallback
    nooa = await asyncio.to_thread(_run_nooa_sidecar, "recall", {"query": query, "limit": limit})
    memory_ids = nooa.get("memory_ids")
    if isinstance(memory_ids, list):
        by_id = {
            str(memory.get("memoryId")): memory
            for memory in memories
            if isinstance(memory, dict) and memory.get("memoryId")
        }
        fallback["memories"] = [by_id[memory_id] for memory_id in memory_ids if memory_id in by_id]
    fallback["nooa"] = nooa
    return fallback


async def spontaneous_recall(query: str, *, limit: int = 5, max_chars: int = 2000) -> dict[str, Any]:
    sync = await sync_nooa_memory()
    if not sync.get("ok"):
        return {**sync, "context": "", "memory_ids": []}
    result = await asyncio.to_thread(
        _run_nooa_sidecar,
        "spontaneous",
        {"query": query, "limit": limit, "max_chars": max_chars},
    )
    result["sync"] = sync
    return result


async def reflect_memory(trigger: str = "manual", *, cycle_id: str | None = None) -> dict[str, Any]:
    allowed = {"five_cycles", "supervisor_intervention", "candidate_acceptance", "manual"}
    if trigger not in allowed:
        raise ValueError(f"trigger must be one of {sorted(allowed)}")
    sync = await sync_nooa_memory()
    if not sync.get("ok"):
        return sync
    result = await asyncio.to_thread(_run_nooa_sidecar, "reflect", {"trigger": trigger})
    if not result.get("ok"):
        return result
    payload = {
        "trigger": trigger,
        "cycle_id": cycle_id,
        "report": result.get("report", {}),
        "archived_memory_ids": result.get("archived_memory_ids", []),
    }
    result["host_receipt"] = await host_request("avo.memory.reflection.record", payload)
    result["sync"] = sync
    return result


__all__ = [
    "add_candidate",
    "bind_tool_result",
    "checkpoint",
    "collect_results",
    "complete",
    "complete_cycle",
    "configure",
    "execution_contract",
    "get_state",
    "initialize",
    "nooa_backend_status",
    "recall",
    "record_evaluation",
    "reflect_memory",
    "remember",
    "spontaneous_recall",
    "stop_gate",
    "sync_nooa_memory",
]
