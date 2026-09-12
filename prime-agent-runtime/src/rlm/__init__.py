"""Tiny rlm-compatible kernel shim for Prime Agent."""

from __future__ import annotations

import sys
import types
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .bash import BashHandle, BashResult, bash
from .harness import HarnessEntry, HarnessScope, HarnessState, RefinementEvent, get_harness_state

_NOT_CALLABLE_MESSAGE = "'rlm' is not callable; spawn a child with: handle = await rlm.spawn('sub-task', name='worker')"
_RENAMED_RUN_MESSAGE = "rlm.run was renamed; spawn a child with: handle = await rlm.spawn('sub-task', name='worker')"


@dataclass(frozen=True)
class RLMSpawnHandle:
    rlm_child_id: str
    name: str
    session_dir: Path
    model: str


@dataclass(frozen=True)
class RLMCreateSessionHandle:
    active_session_id: str
    session_id: str
    name: str
    session_file: Path
    model: str


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


@dataclass(frozen=True)
class RLMChildResult:
    """Terminal or in-progress state of one direct child, from `collect()`."""

    rlm_child_id: str
    session_name: str | None
    session_dir: Path | None
    status: str
    settled: bool
    answer_preview: str | None
    error: str | None
    duration_ms: int | None
    tool_use_count: int | None
    replied_since_task: bool | None


def _spawn_handle_from_payload(payload: Any) -> RLMSpawnHandle:
    if not isinstance(payload, dict):
        raise RuntimeError("rlm.spawn returned an invalid spawn handle")
    child_id = payload.get("rlm_child_id")
    name = payload.get("name")
    session_dir = payload.get("session_dir")
    model = payload.get("model")
    if not all(isinstance(value, str) and value for value in (child_id, name, session_dir, model)):
        raise RuntimeError("rlm.spawn returned an invalid spawn handle")
    return RLMSpawnHandle(
        rlm_child_id=child_id,
        name=name,
        session_dir=Path(session_dir),
        model=model,
    )


def _create_session_handle_from_payload(payload: Any) -> RLMCreateSessionHandle:
    if not isinstance(payload, dict):
        raise RuntimeError("rlm.create_session returned an invalid payload")
    active_session_id = payload.get("active_session_id")
    session_id = payload.get("session_id")
    name = payload.get("name")
    session_file = payload.get("session_file")
    model = payload.get("model")
    if not all(isinstance(value, str) and value for value in (active_session_id, session_id, name, session_file, model)):
        raise RuntimeError("rlm.create_session returned an invalid payload structure")
    return RLMCreateSessionHandle(
        active_session_id=active_session_id,
        session_id=session_id,
        name=name,
        session_file=Path(session_file),
        model=model,
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


async def spawn(
    prompt: str,
    *,
    name: str,
    model: str | None = None,
    thinking: str | None = None,
) -> RLMSpawnHandle:
    """Spawn a recursive Prime Agent child and return once its task is admitted.

    ``name`` is required and must be unique among siblings.
    ``model`` selects a child with an exact ``provider/model`` selector.
    ``thinking`` sets the child reasoning level (e.g. 'off', 'low', 'medium', 'high');
    defaults to the parent level; levels invalid for the resolved model fail the spawn.
    """
    if not isinstance(prompt, str):
        raise TypeError(f"prompt must be str, got {type(prompt).__name__}")
    kwargs: dict[str, Any] = {"name": name}
    if model is not None:
        kwargs["model"] = model
    if thinking is not None:
        kwargs["thinking"] = thinking
    # Wire type stays "rlm.run" so kernels and hosts of different versions stay compatible.
    payload = await host_request("rlm.run", {"prompt": prompt, "kwargs": kwargs})
    return _spawn_handle_from_payload(payload)


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


async def create_session(
    prompt: str,
    name: str | None = None,
    model: str | None = None,
    thinking: str | None = None,
    cwd: str | None = None,
) -> RLMCreateSessionHandle:
    """Create and prompt a resident depth-0 daemon session.

    Only daemon-backed depth-0 sessions support this operation. The optional
    arguments set the session name, model, thinking level, and working directory.
    """
    if not isinstance(prompt, str):
        raise TypeError(f"prompt must be str, got {type(prompt).__name__}")
    kwargs: dict[str, Any] = {}
    if name is not None:
        kwargs["name"] = name
    if model is not None:
        kwargs["model"] = model
    if thinking is not None:
        kwargs["thinking"] = thinking
    if cwd is not None:
        kwargs["cwd"] = cwd
    payload = await host_request("rlm.create_session", {"prompt": prompt, "kwargs": kwargs})
    return _create_session_handle_from_payload(payload)


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
    return RLMSubagent(
        rlm_child_id=child_id,
        active_session_id=active_session_id,
        session_id=session_id,
        session_name=session_name,
        session_dir=Path(session_dir),
        status=status,
    )


async def list_subagents() -> list[RLMSubagent]:
    """List direct RLM children retained by the current parent session."""
    payload = await host_request("rlm.list_subagents")
    entries = payload.get("subagents")
    if not isinstance(entries, list):
        raise RuntimeError("rlm.list_subagents returned an invalid subagents registry")
    return [_subagent_from_payload(entry) for entry in entries]


def _collect_target_selector(target: Any) -> str:
    """Normalize a collect target: spawn handle, subagent row, or a name/id string."""
    if isinstance(target, RLMSpawnHandle):
        return target.rlm_child_id
    if isinstance(target, RLMSubagent):
        return target.rlm_child_id
    if isinstance(target, str) and target.strip():
        return target.strip()
    raise TypeError(
        f"collect target must be RLMSpawnHandle, RLMSubagent, or non-empty str, got {type(target).__name__}"
    )


def _child_result_from_payload(payload: Any) -> RLMChildResult:
    if not isinstance(payload, dict):
        raise RuntimeError("rlm.collect returned an invalid result entry")
    child_id = payload.get("rlm_child_id")
    if not isinstance(child_id, str) or not child_id:
        raise RuntimeError("rlm.collect entry is missing rlm_child_id")
    status = payload.get("status")
    if status not in {"queued", "running", "done", "error", "cancelled"}:
        raise RuntimeError("rlm.collect entry has invalid status")
    settled = payload.get("settled")
    if not isinstance(settled, bool):
        raise RuntimeError("rlm.collect entry has invalid settled flag")

    def _optional_str(field: str) -> str | None:
        value = payload.get(field)
        if value is None:
            return None
        if not isinstance(value, str):
            raise RuntimeError(f"rlm.collect entry has invalid {field}")
        return value

    def _optional_int(field: str) -> int | None:
        value = payload.get(field)
        if value is None:
            return None
        if not isinstance(value, int) or isinstance(value, bool):
            raise RuntimeError(f"rlm.collect entry has invalid {field}")
        return value

    session_dir = _optional_str("session_dir")
    replied = payload.get("replied_since_task")
    if replied is not None and not isinstance(replied, bool):
        raise RuntimeError("rlm.collect entry has invalid replied_since_task")
    return RLMChildResult(
        rlm_child_id=child_id,
        session_name=_optional_str("session_name"),
        session_dir=Path(session_dir) if session_dir else None,
        status=status,
        settled=settled,
        answer_preview=_optional_str("answer_preview"),
        error=_optional_str("error"),
        duration_ms=_optional_int("duration_ms"),
        tool_use_count=_optional_int("tool_use_count"),
        replied_since_task=replied,
    )


async def collect(
    targets: Any = None,
    *,
    timeout_ms: int = 0,
) -> list[RLMChildResult]:
    """Collect typed results from direct RLM children.

    ``targets`` selects children: spawn handles, subagent rows, name strings,
    or a list mixing all three. ``None`` (or an empty list) selects every
    direct child that is not being deleted.

    ``timeout_ms`` bounds the wait for the selected children to settle:
    0 returns a non-blocking snapshot immediately; a positive value blocks
    only this kernel call until the runs settle or the timeout elapses —
    a timeout returns current snapshots, never an error, and the parent
    session is never steered. Completed children keep their result until
    deleted, so a later ``collect`` re-reads them without waiting.
    """
    if not isinstance(timeout_ms, int) or isinstance(timeout_ms, bool) or timeout_ms < 0:
        raise TypeError("timeout_ms must be a non-negative int")
    if targets is None:
        selectors: list[str] = []
    elif isinstance(targets, (RLMSpawnHandle, RLMSubagent, str)):
        selectors = [_collect_target_selector(targets)]
    elif isinstance(targets, (list, tuple)):
        selectors = [_collect_target_selector(target) for target in targets]
    else:
        raise TypeError(
            f"targets must be None, a target, or a list of targets, got {type(targets).__name__}"
        )
    payload = await host_request("rlm.collect", {"targets": selectors, "timeout_ms": timeout_ms})
    results = payload.get("results")
    if not isinstance(results, list):
        raise RuntimeError("rlm.collect returned an invalid results list")
    return [_child_result_from_payload(entry) for entry in results]


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


class _RLMNamespace:
    harness = _harness_state
    get_harness_state = staticmethod(get_harness_state)

    async def spawn(
        self,
        prompt: str,
        *,
        name: str,
        model: str | None = None,
        thinking: str | None = None,
    ) -> RLMSpawnHandle:
        return await spawn(prompt, name=name, model=model, thinking=thinking)

    async def create_session(
        self,
        prompt: str,
        name: str | None = None,
        model: str | None = None,
        thinking: str | None = None,
        cwd: str | None = None,
    ) -> RLMCreateSessionHandle:
        return await create_session(prompt, name=name, model=model, thinking=thinking, cwd=cwd)

    async def find_models(self, query: str = "", limit: int = 8) -> list[RLMModel]:
        return await find_models(query, limit)

    async def list_subagents(self) -> list[RLMSubagent]:
        return await list_subagents()

    async def delete_subagent(self, target: str | RLMSubagent) -> RLMSubagent:
        return await delete_subagent(target)

    async def collect(self, targets: Any = None, *, timeout_ms: int = 0) -> list[RLMChildResult]:
        return await collect(targets, timeout_ms=timeout_ms)

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        raise TypeError(_NOT_CALLABLE_MESSAGE)

    # AttributeError keeps hasattr() semantics intact while still naming the replacement.
    def __getattr__(self, name: str) -> Any:
        if name == "run":
            raise AttributeError(_RENAMED_RUN_MESSAGE)
        raise AttributeError(f"'rlm' object has no attribute {name!r}")


rlm = _RLMNamespace()
harness = _harness_state


class _NotCallableModule(types.ModuleType):
    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        raise TypeError(_NOT_CALLABLE_MESSAGE)


sys.modules[__name__].__class__ = _NotCallableModule

__all__ = [
    "BashHandle",
    "BashResult",
    "HarnessEntry",
    "HarnessScope",
    "HarnessState",
    "McpIntegration",
    "McpToolError",
    "NotEnabled",
    "RLMCreateSessionHandle",
    "RLMModel",
    "RLMSpawnHandle",
    "RLMSubagent",
    "create_session",
    "RefinementEvent",
    "bash",
    "delete_subagent",
    "emit",
    "find_models",
    "get_harness_state",
    "harness",
    "host_request",
    "list_subagents",
    "rlm",
    "spawn",
]

# Lazily re-export the MCP base class. Kept lazy so `import rlm` never requires
# the optional `mcp` SDK — only integration packages that subclass it do.
_LAZY_MCP = {"McpIntegration", "McpToolError", "NotEnabled"}


def __getattr__(name: str) -> Any:  # noqa: D401 - module-level lazy attr hook
    if name in _LAZY_MCP:
        from . import mcp_base

        return getattr(mcp_base, name)
    if name == "run":
        raise AttributeError(_RENAMED_RUN_MESSAGE)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
