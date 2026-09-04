"""Tiny rlm-compatible kernel shim for Prime Agent."""

from __future__ import annotations

import sys
import types
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .bash import BashHandle, BashResult, bash
from .harness import HarnessEntry, HarnessScope, HarnessState, RefinementEvent, get_harness_state

@dataclass(frozen=True)
class RLMSpawnHandle:
    rlm_child_id: str
    name: str
    session_dir: Path
    model: str
    task_id: str | None = None


@dataclass(frozen=True)
class RLMModel:
    provider: str
    id: str
    name: str
    selector: str


@dataclass(frozen=True)
class RLMSubagent:
    rlm_child_id: str
    active_session_id: str | None
    session_id: str | None
    session_name: str
    session_dir: Path
    status: str
    task_id: str | None = None


def _spawn_handle_from_payload(payload: Any) -> RLMSpawnHandle:
    if not isinstance(payload, dict):
        raise RuntimeError("rlm.run returned an invalid spawn handle")
    child_id = payload.get("rlm_child_id")
    name = payload.get("name")
    session_dir = payload.get("session_dir")
    model = payload.get("model")
    task_id = payload.get("task_id")
    if not all(isinstance(value, str) and value for value in (child_id, name, session_dir, model)):
        raise RuntimeError("rlm.run returned an invalid spawn handle")
    if task_id is not None and (not isinstance(task_id, str) or not task_id):
        raise RuntimeError("rlm.run returned an invalid task id")
    return RLMSpawnHandle(
        rlm_child_id=child_id,
        name=name,
        session_dir=Path(session_dir),
        model=model,
        task_id=task_id,
    )


def _parse_host_reply(request_type: str, reply: dict[str, Any]) -> dict[str, Any]:
    status = reply.get("status")
    if status == "ok":
        return reply["result"]
    if status == "error":
        raise RuntimeError(str(reply.get("error") or f"host request {request_type} failed"))
    raise RuntimeError(f"host request {request_type} returned unexpected status: {status!r}")


async def host_request(request_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Send a typed request to the Prime Agent host and await its reply.

    This is the kernel side of the generic host bridge: Python skills call
    ``await host_request("<type>", {...})`` and the TypeScript host dispatches
    on the type. Raises RuntimeError when the host reports an error or when no
    handler for the type is registered in this session.
    """
    if not isinstance(request_type, str) or not request_type:
        raise TypeError("request_type must be a non-empty str")
    if payload is not None and not isinstance(payload, dict):
        raise TypeError(f"payload must be a dict or None, got {type(payload).__name__}")
    from . import repl

    # request_type goes last so a payload "type" key cannot reroute the request.
    reply = await repl.host_request({**(payload or {}), "type": request_type})
    return _parse_host_reply(request_type, reply)


def emit(data: dict[str, Any]) -> None:
    """Ship one display event (dict of MIME type -> JSON payload) to the host."""
    from . import repl

    repl.emit(data)


async def run(prompt: str, **kwargs: Any) -> RLMSpawnHandle:
    """Spawn a recursive Prime Agent child and return once its task is admitted.

    ``model`` selects a child with an exact ``provider/model`` selector.
    ``thinking`` sets the child reasoning level (e.g. 'off', 'low', 'medium', 'high');
    defaults to the parent level; levels invalid for the resolved model fail the spawn.
    """
    if not isinstance(prompt, str):
        raise TypeError(f"prompt must be str, got {type(prompt).__name__}")
    payload = await host_request("rlm.run", {"prompt": prompt, "kwargs": kwargs})
    return _spawn_handle_from_payload(payload)


async def delegate(prompt: str, task: dict[str, Any], **kwargs: Any) -> RLMSpawnHandle:
    """Atomically transfer a narrower task to a new recursive child.

    The parent must own every exclusive claim in ``task``. Prime persists the
    task, binds it to the new child, and rolls the transfer back if startup
    fails. The child receives the inherited context envelope automatically.
    """
    if not isinstance(prompt, str):
        raise TypeError(f"prompt must be str, got {type(prompt).__name__}")
    if not isinstance(task, dict):
        raise TypeError(f"task must be dict, got {type(task).__name__}")
    payload = await host_request(
        "rlm.delegate",
        {"prompt": prompt, "task": task, "kwargs": kwargs},
    )
    return _spawn_handle_from_payload(payload)


async def replace(task_id: str, prompt: str, **kwargs: Any) -> RLMSpawnHandle:
    """Atomically replace the runtime owning an existing supervised task."""
    if not isinstance(task_id, str) or not task_id.strip():
        raise TypeError("task_id must be a non-empty str")
    if not isinstance(prompt, str):
        raise TypeError(f"prompt must be str, got {type(prompt).__name__}")
    payload = await host_request(
        "rlm.replace",
        {"task_id": task_id.strip(), "prompt": prompt, "kwargs": kwargs},
    )
    return _spawn_handle_from_payload(payload)


class _RLMTaskAPI:
    async def current(self) -> dict[str, Any]:
        """Return this agent's task and complete inherited context envelope."""
        return await host_request("rlm.task.current")

    async def snapshot(self, offset: int = 0, limit: int = 100) -> dict[str, Any]:
        """Return tree-wide ownership plus generic supervision alerts."""
        if not isinstance(offset, int):
            raise TypeError(f"offset must be int, got {type(offset).__name__}")
        if not isinstance(limit, int):
            raise TypeError(f"limit must be int, got {type(limit).__name__}")
        return await host_request("rlm.task.snapshot", {"offset": offset, "limit": limit})

    async def root_context(self) -> dict[str, Any] | None:
        """Resolve the complete immutable root context on demand."""
        payload = await host_request("rlm.task.root_context")
        value = payload.get("rootContext")
        if value is not None and not isinstance(value, dict):
            raise RuntimeError("rlm.task.root_context returned an invalid context")
        return value

    async def defer_until_children_complete(self) -> dict[str, Any]:
        """Suspend coordination and request one follow-up after descendants finish.

        The call returns immediately after the durable wait is registered. When
        ``state`` is ``waiting``, end the current turn; Prime resumes the task
        automatically once every delegated descendant is terminal.
        """
        return await host_request("rlm.task.defer_until_children_complete")

    async def plan(
        self,
        mode: str,
        rationale: str,
        *,
        boundaries: list[str] | None = None,
        expected_evidence: list[str] | None = None,
    ) -> dict[str, Any]:
        """Choose leaf execution or recursive coordination before exploration."""
        plan: dict[str, Any] = {
            "mode": mode,
            "rationale": rationale,
            "boundaries": boundaries or [],
            "expectedEvidence": expected_evidence or [],
        }
        return await host_request("rlm.task.plan", {"plan": plan})

    async def update(
        self,
        summary: str,
        *,
        evidence_refs: list[str] | None = None,
        completed_questions: list[str] | None = None,
    ) -> dict[str, Any]:
        """Persist bounded progress and evidence references for the current task."""
        payload: dict[str, Any] = {"summary": summary}
        if evidence_refs is not None:
            payload["evidence_refs"] = evidence_refs
        if completed_questions is not None:
            payload["completed_questions"] = completed_questions
        return await host_request("rlm.task.update", payload)

    async def handoff(self, handoff: dict[str, Any]) -> dict[str, Any]:
        """Persist reusable findings and remaining work before yielding control."""
        if not isinstance(handoff, dict):
            raise TypeError(f"handoff must be dict, got {type(handoff).__name__}")
        return await host_request("rlm.task.handoff", {"handoff": handoff})

    async def complete(self, result: dict[str, Any]) -> dict[str, Any]:
        """Complete the current task with a bounded structured result."""
        if not isinstance(result, dict):
            raise TypeError(f"result must be dict, got {type(result).__name__}")
        return await host_request("rlm.task.complete", {"result": result})

    async def report_gap(
        self,
        kind: str,
        description: str,
        *,
        needed_information: str | None = None,
        evidence_refs: list[str] | None = None,
    ) -> dict[str, Any]:
        """Report missing coverage, context, or a dependency to the direct parent."""
        payload: dict[str, Any] = {"kind": kind, "description": description}
        if needed_information is not None:
            payload["needed_information"] = needed_information
        if evidence_refs is not None:
            payload["evidence_refs"] = evidence_refs
        return await host_request("rlm.task.report_gap", payload)

    async def resolve_gap(
        self,
        task_id: str,
        gap_id: str,
        resolution: str,
        *,
        status: str = "resolved",
        evidence_refs: list[str] | None = None,
    ) -> dict[str, Any]:
        """Resolve or decline a directly supervised task gap."""
        payload: dict[str, Any] = {
            "task_id": task_id,
            "gap_id": gap_id,
            "status": status,
            "resolution": resolution,
        }
        if evidence_refs is not None:
            payload["evidence_refs"] = evidence_refs
        return await host_request("rlm.task.resolve_gap", payload)

    async def cancel(self, task_id: str, reason: str) -> dict[str, Any]:
        """Cancel a directly supervised task; the root may cancel any descendant."""
        return await host_request("rlm.task.cancel", {"task_id": task_id, "reason": reason})

def _model_from_payload(payload: Any) -> RLMModel:
    if not isinstance(payload, dict):
        raise RuntimeError("rlm.find_models returned an invalid model entry")
    provider = payload.get("provider")
    model_id = payload.get("id")
    name = payload.get("name")
    selector = payload.get("selector")
    if not all(isinstance(value, str) and value for value in (provider, model_id, name, selector)):
        raise RuntimeError("rlm.find_models returned an invalid model entry")
    return RLMModel(provider=provider, id=model_id, name=name, selector=selector)


async def find_models(query: str = "", limit: int = 8) -> list[RLMModel]:
    """Search a bounded list of models backed by active user credentials."""
    if not isinstance(query, str):
        raise TypeError(f"query must be str, got {type(query).__name__}")
    if not isinstance(limit, int):
        raise TypeError(f"limit must be int, got {type(limit).__name__}")
    payload = await host_request("rlm.find_models", {"query": query, "limit": limit})
    models = payload.get("models")
    if not isinstance(models, list):
        raise RuntimeError("rlm.find_models returned an invalid models list")
    return [_model_from_payload(model) for model in models]


def _subagent_from_payload(payload: Any, operation: str = "rlm.list_subagents") -> RLMSubagent:
    if not isinstance(payload, dict):
        raise RuntimeError(f"{operation} returned an invalid subagent entry")
    child_id = payload.get("rlm_child_id")
    active_session_id = payload.get("active_session_id")
    session_id = payload.get("session_id")
    session_name = payload.get("session_name")
    session_dir = payload.get("session_dir")
    status = payload.get("status")
    task_id = payload.get("task_id")
    if not isinstance(child_id, str) or not child_id:
        raise RuntimeError(f"{operation} entry is missing rlm_child_id")
    if active_session_id is not None and not isinstance(active_session_id, str):
        raise RuntimeError(f"{operation} entry has invalid active_session_id")
    if session_id is not None and not isinstance(session_id, str):
        raise RuntimeError(f"{operation} entry has invalid session_id")
    if not isinstance(session_name, str) or not session_name:
        raise RuntimeError(f"{operation} entry is missing session_name")
    if not isinstance(session_dir, str) or not session_dir:
        raise RuntimeError(f"{operation} entry is missing session_dir")
    if status not in {"running", "completed", "error"}:
        raise RuntimeError(f"{operation} entry has invalid status")
    if task_id is not None and (not isinstance(task_id, str) or not task_id):
        raise RuntimeError(f"{operation} entry has invalid task_id")
    return RLMSubagent(
        rlm_child_id=child_id,
        active_session_id=active_session_id,
        session_id=session_id,
        session_name=session_name,
        session_dir=Path(session_dir),
        status=status,
        task_id=task_id,
    )


async def list_subagents() -> list[RLMSubagent]:
    """List direct RLM children retained by the current parent session."""
    payload = await host_request("rlm.list_subagents")
    entries = payload.get("subagents")
    if not isinstance(entries, list):
        raise RuntimeError("rlm.list_subagents returned an invalid subagents registry")
    return [_subagent_from_payload(entry) for entry in entries]


async def delete_subagent(target: str | RLMSubagent) -> RLMSubagent:
    """Delete one running or retained direct child from the current parent session."""
    if isinstance(target, RLMSubagent):
        selector = target.rlm_child_id
    elif isinstance(target, str):
        selector = target.strip()
        if not selector:
            raise ValueError("target must not be empty")
    else:
        raise TypeError(f"target must be str or RLMSubagent, got {type(target).__name__}")
    payload = await host_request("rlm.delete_subagent", {"target": selector})
    return _subagent_from_payload(payload.get("subagent"), "rlm.delete_subagent")


class _HarnessProxy:
    """Resolve the harness state against the current environment on every access.

    Session env vars may be applied after import, so a state bound at import
    time could freeze an env-less resolution. Resolution must never raise (a
    failure inside the kernel namespace would take down the kernel). When the
    local store is genuinely unconfigured (no session env, e.g. --no-session)
    reads see an empty view but local writes raise instructively instead of
    vanishing on kernel exit; any other resolution failure degrades to a shared
    in-memory store until local resolution starts succeeding.
    """

    _fallback: HarnessState | None = None
    _unpersisted: HarnessState | None = None

    def _resolve(self) -> HarnessState:
        try:
            return get_harness_state()
        except RuntimeError as exc:
            if "Local harness state requires" in str(exc):
                if _HarnessProxy._unpersisted is None:
                    _HarnessProxy._unpersisted = HarnessState(
                        in_memory=True,
                        local_write_error=(
                            f"{exc} This session has no persistent local harness store; "
                            "pass global_=True to persist across sessions."
                        ),
                    )
                return _HarnessProxy._unpersisted
            return self._degraded()
        except Exception:  # pragma: no cover - harness access must never raise
            return self._degraded()

    @staticmethod
    def _degraded() -> HarnessState:
        if _HarnessProxy._fallback is None:
            _HarnessProxy._fallback = HarnessState(in_memory=True)
        return _HarnessProxy._fallback

    def __getattr__(self, name: str) -> Any:
        return getattr(self._resolve(), name)

    def __repr__(self) -> str:
        return repr(self._resolve())


_harness_state = _HarnessProxy()


class _RLMCallable:
    harness = _harness_state
    get_harness_state = staticmethod(get_harness_state)
    task = _RLMTaskAPI()

    async def run(self, prompt: str, **kwargs: Any) -> RLMSpawnHandle:
        return await run(prompt, **kwargs)

    async def delegate(self, prompt: str, task: dict[str, Any], **kwargs: Any) -> RLMSpawnHandle:
        return await delegate(prompt, task, **kwargs)

    async def replace(self, task_id: str, prompt: str, **kwargs: Any) -> RLMSpawnHandle:
        return await replace(task_id, prompt, **kwargs)

    async def find_models(self, query: str = "", limit: int = 8) -> list[RLMModel]:
        return await find_models(query, limit)

    async def list_subagents(self) -> list[RLMSubagent]:
        return await list_subagents()

    async def delete_subagent(self, target: str | RLMSubagent) -> RLMSubagent:
        return await delete_subagent(target)

    async def __call__(self, prompt: str, **kwargs: Any) -> RLMSpawnHandle:
        return await run(prompt, **kwargs)


rlm = _RLMCallable()
harness = _harness_state


class _CallableModule(types.ModuleType):
    async def __call__(self, prompt: str, **kwargs: Any) -> RLMSpawnHandle:
        return await run(prompt, **kwargs)


sys.modules[__name__].__class__ = _CallableModule

__all__ = [
    "BashHandle",
    "BashResult",
    "HarnessEntry",
    "HarnessScope",
    "HarnessState",
    "McpIntegration",
    "McpToolError",
    "NotEnabled",
    "RLMModel",
    "RLMSpawnHandle",
    "RLMSubagent",
    "RefinementEvent",
    "bash",
    "delete_subagent",
    "emit",
    "delegate",
    "find_models",
    "get_harness_state",
    "harness",
    "host_request",
    "list_subagents",
    "replace",
    "rlm",
    "run",
]

# Lazily re-export the MCP base class. Kept lazy so `import rlm` never requires
# the optional `mcp` SDK — only integration packages that subclass it do.
_LAZY_MCP = {"McpIntegration", "McpToolError", "NotEnabled"}


def __getattr__(name: str) -> Any:  # noqa: D401 - module-level lazy attr hook
    if name in _LAZY_MCP:
        from . import mcp_base

        return getattr(mcp_base, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
